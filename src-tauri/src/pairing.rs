//! Pairing: the connect code `sail fde pair` prints, and the settings Mast keeps once one has
//! connected. A code is `sail1.` followed by base64url of one JSON object naming the box (host,
//! port, operator login, SSH host key), the person (handle, email, a private key made for this
//! pairing) and the API (token, loopback address). Nothing here touches the Mac's
//! `~/.ssh/config` or its ssh-agent: what the code carries is the whole route.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use russh::keys::{decode_secret_key, key, load_secret_key, parse_public_key_base64};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::ssh::{
    parse_server, parse_yaml, write_private, yaml_scalar, Backend, ConnectionSettings, Error, Route, SailResponse,
};

pub const SETTINGS_FILE: &str = ".sail/mast.yaml";
const KEYS_DIR: &str = ".sail/keys";
const CODE_PREFIX: &str = "sail1.";
const CODE_VERSION: u64 = 1;
/// Where a container's sshd listens: `/v1/projects/{p}/connect` names an address, never a port.
pub const CONTAINER_SSH_PORT: u16 = 22;

/// What the first-run screen says when the box refused the paired token mid-session.
pub const REVOKED: &str = "This code was revoked on the box; ask for a new one.";

const NOT_A_CODE: &str = "That does not look like a connect code; paste the whole code, starting with sail1.";
const DAMAGED: &str = "This connect code is incomplete or was altered in copying; paste the whole code again.";
const NOT_SETTINGS: &str =
    "This connect code is cut short or does not hold connection settings; paste the whole code again, or ask for a new one.";
const NEWER_CODE: &str = "This connect code is newer than this Mast understands; update Mast, then paste it again.";
const BAD_KEY: &str = "The key in this connect code cannot be read; ask for a new one.";

/// The box a connect code named and the proof at both ends: the host key Mast pins, and the
/// private key that is the only identity Mast offers.
#[derive(Clone)]
pub struct Pairing {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub host_key: key::PublicKey,
    pub key: Arc<key::KeyPair>,
}

/// A parsed connect code. Deliberately not `Debug`: it holds the token and the private key,
/// and neither may reach a log line or an error message.
pub struct ConnectCode {
    pub handle: String,
    pub email: Option<String>,
    pub pairing: Pairing,
    host_key_line: String,
    key_text: String,
    token: String,
    server: String,
}

/// What the first-run screen shows under the field once a code parses.
#[derive(Serialize, Debug, PartialEq)]
pub struct CodePreview {
    pub handle: String,
    pub email: Option<String>,
    pub host: String,
}

impl ConnectCode {
    /// Parses a pasted code. Whitespace anywhere is dropped first: a code copied out of a
    /// terminal arrives wrapped. Every refusal is one sentence, and none quotes the code.
    pub fn parse(text: &str) -> Result<Self, Error> {
        let bad = |sentence: &str| Error::BadCode(sentence.to_string());
        let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
        let encoded = compact.strip_prefix(CODE_PREFIX).ok_or_else(|| bad(NOT_A_CODE))?;
        let json = base64url(encoded).ok_or_else(|| bad(DAMAGED))?;
        let fields: Map<String, Value> = serde_json::from_slice(&json).map_err(|_| bad(NOT_SETTINGS))?;

        match fields.get("v").map(Value::as_u64) {
            None => return Err(missing("v")),
            Some(Some(CODE_VERSION)) => {}
            Some(_) => return Err(bad(NEWER_CODE)),
        }
        let handle = text_field(&fields, "handle", is_name)?;
        let host = text_field(&fields, "host", is_host)?;
        let user = text_field(&fields, "user", is_name)?;
        let token = text_field(&fields, "token", is_token)?;
        let server = text_field(&fields, "server", is_server)?;
        let port = match fields.get("port") {
            None => return Err(missing("port")),
            Some(value) => value
                .as_u64()
                .and_then(|port| u16::try_from(port).ok())
                .filter(|port| *port != 0)
                .ok_or_else(|| invalid("port"))?,
        };
        let email = match fields.get("email").filter(|value| !value.is_null()) {
            None => None,
            Some(value) => Some(value.as_str().filter(|email| is_email(email)).ok_or_else(|| invalid("email"))?),
        }
        .filter(|email| !email.is_empty())
        .map(str::to_string);

        let host_key_line = text_field(&fields, "host_key", |_| true)?;
        let (host_key_line, host_key) = parse_host_key(&host_key_line).ok_or_else(|| invalid("host key"))?;
        let key_text = text_field(&fields, "key", |_| true)?;
        let key = decode_secret_key(&key_text, None).map_err(|_| bad(BAD_KEY))?;

        Ok(ConnectCode {
            handle,
            email,
            pairing: Pairing { host, port, user, host_key, key: Arc::new(key) },
            host_key_line,
            key_text,
            token,
            server,
        })
    }

    pub fn preview(&self) -> CodePreview {
        CodePreview {
            handle: self.handle.clone(),
            email: self.email.clone(),
            host: self.pairing.host.clone(),
        }
    }

    fn settings(&self, home: &Path) -> ConnectionSettings {
        let (server_host, server_port) = parse_server(&self.server);
        ConnectionSettings {
            home: home.to_path_buf(),
            route: Route::Paired(self.pairing.clone()),
            server_host,
            server_port,
            token: Some(self.token.clone()),
        }
    }
}

fn missing(field: &str) -> Error {
    Error::BadCode(format!(
        "This connect code is missing its {}; ask for a new one.",
        field_label(field)
    ))
}

fn invalid(field: &str) -> Error {
    Error::BadCode(format!(
        "This connect code's {} is not valid; ask for a new one.",
        field_label(field)
    ))
}

fn field_label(field: &str) -> String {
    match field {
        "v" => "version".to_string(),
        other => other.replace('_', " "),
    }
}

fn text_field(fields: &Map<String, Value>, name: &str, valid: fn(&str) -> bool) -> Result<String, Error> {
    let text = fields
        .get(name)
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| missing(name))?;
    if valid(text) {
        Ok(text.to_string())
    } else {
        Err(invalid(name))
    }
}

/// A handle, a login or a project: the characters that are safe in a file name and a URL path.
fn is_name(text: &str) -> bool {
    text.chars().any(|c| c != '.') && text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// A hostname or an IP literal (`:` for IPv6). No `/`, so it is also safe in the key's file name.
fn is_host(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':'))
}

/// The token rides an HTTP header and a YAML line: printable, unbroken, unquoted.
fn is_token(text: &str) -> bool {
    text.chars().all(|c| c.is_ascii_graphic() && !matches!(c, '\'' | '"'))
}

fn is_email(text: &str) -> bool {
    text.chars().all(|c| !c.is_control() && !c.is_whitespace())
}

/// The API's address on the box, as the code spells it: `http://host[:port]`.
fn is_server(text: &str) -> bool {
    text.strip_prefix("http://").is_some_and(is_host)
}

/// `<type> <base64>[ comment]` to the line Mast stores (comment dropped) and the key it pins.
fn parse_host_key(line: &str) -> Option<(String, key::PublicKey)> {
    let mut parts = line.split_whitespace();
    let (algorithm, blob) = (parts.next()?, parts.next()?);
    let blob_ok = blob.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '='));
    if !is_name(algorithm) || !blob_ok {
        return None;
    }
    let key = parse_public_key_base64(blob).ok()?;
    Some((format!("{algorithm} {blob}"), key))
}

/// RFC 4648 base64url, padding optional. Decoded by hand: Mast takes no dependency for it.
fn base64url(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut bits, mut pending) = (0u32, 0u8);
    for byte in text.trim_end_matches('=').bytes() {
        let sextet = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        };
        bits = (bits << 6) | u32::from(sextet);
        pending += 6;
        if pending >= 8 {
            pending -= 8;
            out.push((bits >> pending) as u8);
        }
    }
    (pending < 6).then_some(out)
}

/// Mast's own settings, when a code has connected before. `None` means the file is absent and
/// the caller may fall back; a file that is there but unusable is an error, never a fallback.
pub fn load(home: &Path) -> Result<Option<ConnectionSettings>, Error> {
    let unusable = |why: &str| Error::BadPairing(why.to_string());
    let raw = match std::fs::read_to_string(home.join(SETTINGS_FILE)) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(unusable("mast.yaml cannot be read")),
    };
    let fields = parse_yaml(&raw);
    let field = |name: &str| {
        fields
            .get(name)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| Error::BadPairing(format!("mast.yaml has no {name}")))
    };

    let port = field("port")?.parse().map_err(|_| unusable("its port is not a number"))?;
    let (_, host_key) = parse_host_key(field("host_key")?).ok_or_else(|| unusable("its host key cannot be read"))?;
    field("key_path")?;
    let key = stored_key(home)
        .and_then(|path| load_secret_key(path, None).ok())
        .ok_or_else(|| unusable("its key file is missing or unreadable"))?;
    let (server_host, server_port) = parse_server(field("server")?);

    Ok(Some(ConnectionSettings {
        home: home.to_path_buf(),
        route: Route::Paired(Pairing {
            host: field("host")?.clone(),
            port,
            user: field("user")?.clone(),
            host_key,
            key: Arc::new(key),
        }),
        server_host,
        server_port,
        token: fields.get("token").cloned().filter(|token| !token.trim().is_empty()),
    }))
}

/// The key file `mast.yaml` records, found by its file name alone under `~/.sail/keys`: a home
/// that moved still finds its key, and no path the file claims can point Mast at anything else.
fn stored_key(home: &Path) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(home.join(SETTINGS_FILE)).ok()?;
    let recorded = PathBuf::from(parse_yaml(&raw).remove("key_path")?);
    Some(home.join(KEYS_DIR).join(recorded.file_name()?))
}

fn remove_if_present(path: &Path) -> Result<(), Error> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

/// Writes what a code carried: the private key to `~/.sail/keys/<host>-<handle>` and the rest to
/// `~/.sail/mast.yaml`, both readable by their owner alone. An earlier pairing is replaced, not
/// destroyed first: its key goes only once the new settings are down, and a save that fails
/// midway leaves no new key behind.
fn store(home: &Path, code: &ConnectCode) -> Result<(), Error> {
    let previous = stored_key(home);
    let keys = home.join(KEYS_DIR);
    let key_path = keys.join(format!("{}-{}", code.pairing.host, code.handle));
    let replaces_in_place = previous.as_deref() == Some(key_path.as_path());
    write_private(&key_path, &format!("{}\n", code.key_text.trim_end()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&keys, std::fs::Permissions::from_mode(0o700))?;
    }

    let port = code.pairing.port.to_string();
    let recorded = key_path.to_string_lossy();
    let settings: String = [
        ("host", code.pairing.host.as_str()),
        ("port", port.as_str()),
        ("user", code.pairing.user.as_str()),
        ("host_key", code.host_key_line.as_str()),
        ("key_path", recorded.as_ref()),
        ("token", code.token.as_str()),
        ("server", code.server.as_str()),
        ("handle", code.handle.as_str()),
        ("email", code.email.as_deref().unwrap_or_default()),
    ]
    .iter()
    .map(|(name, value)| format!("{name}: {}\n", yaml_scalar(value)))
    .collect();
    if let Err(e) = write_private(&home.join(SETTINGS_FILE), &settings) {
        if !replaces_in_place {
            let _ = std::fs::remove_file(&key_path);
        }
        return Err(e);
    }
    match previous {
        Some(old) if !replaces_in_place => remove_if_present(&old),
        _ => Ok(()),
    }
}

/// Forgets the box on this Mac: the key file, then `mast.yaml`. The pairing on the box is not
/// touched (that is `sail fde unpair`).
pub fn forget(home: &Path) -> Result<(), Error> {
    if let Some(key) = stored_key(home) {
        remove_if_present(&key)?;
    }
    remove_if_present(&home.join(SETTINGS_FILE))
}

/// The first run's Connect: builds the backend from the code alone, proves the whole path (SSH
/// to the pinned box with the code's key, a forward to its API, `whoami` with its token), and
/// only then writes anything. A failure is one sentence and leaves the Mac as it was.
pub async fn pair(home: &Path, text: &str) -> Result<Backend, Error> {
    let code = ConnectCode::parse(text)?;
    let host = &code.pairing.host;
    let backend = Backend::new(code.settings(home));
    let whoami = backend.sail_request("GET", "/v1/whoami", None, None).await.map_err(|e| match e {
        Error::BoxUnreachable(_) | Error::HostKeyChanged(_) | Error::KeyRefused(_) => e,
        _ => Error::Refused(format!(
            "The box at {host} let this Mac in, but its Sail service did not answer; ask the box owner to check it."
        )),
    })?;
    if whoami.status != 200 {
        let said = api_error(&whoami.body).unwrap_or_else(|| format!("HTTP {}", whoami.status));
        return Err(Error::Refused(format!(
            "The box at {host} refused this code ({}); ask for a new one.",
            said.trim_end_matches('.')
        )));
    }
    store(home, &code).map_err(|e| {
        Error::Refused(format!("Mast reached the box at {host} but could not save the connection on this Mac ({e})."))
    })?;
    Ok(backend)
}

/// The message of the box's structured error body, when it sent one.
fn api_error(body: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(body).ok()?;
    parsed.get("error")?.get("message")?.as_str().map(str::to_string)
}

/// A 2xx JSON body, or the box's own sentence for why not.
fn answered(response: &SailResponse, asked: &str) -> Result<Value, Error> {
    if !(200..300).contains(&response.status) {
        return Err(Error::Refused(api_error(&response.body).unwrap_or_else(|| {
            format!("The box answered HTTP {} when asked for {asked}.", response.status)
        })));
    }
    serde_json::from_str(&response.body).map_err(|_| Error::BadResponse)
}

/// Every project in the box's catalog (`GET /v1/projects`).
pub fn project_names(response: &SailResponse) -> Result<Vec<String>, Error> {
    let body = answered(response, "its projects")?;
    let projects = body.get("projects").and_then(Value::as_array).ok_or(Error::BadResponse)?;
    Ok(projects
        .iter()
        .filter_map(|project| project.get("name")?.as_str().map(str::to_string))
        .collect())
}

/// The request that asks the box where a project's container is. The project is named by the
/// webview and lands in a hand-built request line, so anything but a plain name is refused.
pub fn connect_path(project: &str) -> Result<String, Error> {
    if is_name(project) {
        Ok(format!("/v1/projects/{project}/connect"))
    } else {
        Err(Error::Refused(format!("'{project}' is not a project name.")))
    }
}

/// The hop from the box to a project's container, as `/v1/projects/{p}/connect` describes it.
/// The response's `server_ip` and `server_user` are ignored: the box route is `mast.yaml`'s.
#[derive(Debug, PartialEq)]
pub struct ContainerHop {
    pub ip: String,
    pub user: String,
}

impl ContainerHop {
    pub fn from_response(project: &str, response: &SailResponse) -> Result<Self, Error> {
        let body = answered(response, &format!("{project}'s container"))?;
        if body.get("workstation_key_set").and_then(Value::as_bool) == Some(false) {
            return Err(Error::Refused(format!(
                "{project}'s container does not trust this Mac's key yet; the box owner must re-apply the project before its files open."
            )));
        }
        let text = |name: &str, valid: fn(&str) -> bool| {
            body.get(name)
                .and_then(Value::as_str)
                .filter(|value| valid(value))
                .map(str::to_string)
                .ok_or(Error::BadResponse)
        };
        Ok(ContainerHop {
            ip: text("container_ip", is_host)?,
            user: text("container_user", is_name)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex as StdMutex;
    use std::time::Duration;

    use async_trait::async_trait;
    use russh::keys::PublicKeyBase64;
    use russh::server::{self, Auth, Msg, Session};
    use russh::{Channel, ChannelId};
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;
    use crate::ssh::connection_status;

    const TOKEN: &str = "sail_tok_3f9a7c";
    const CONTAINER_IP: &str = "10.171.87.10";

    fn base64(bytes: &[u8], alphabet: &[u8; 64], pad: bool) -> String {
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let word = chunk.iter().fold(0u32, |word, byte| (word << 8) | u32::from(*byte)) << (8 * (3 - chunk.len()));
            for i in 0..4 {
                if i <= chunk.len() {
                    out.push(alphabet[(word >> (18 - 6 * i)) as usize & 63] as char);
                } else if pad {
                    out.push('=');
                }
            }
        }
        out
    }

    const URL_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const STD_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    fn ssh_string(out: &mut Vec<u8>, bytes: &[u8]) {
        out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        out.extend_from_slice(bytes);
    }

    /// An ed25519 key as `ssh-keygen -N ""` writes it (openssh-key-v1, unencrypted), which is
    /// what `sail fde pair` puts in a code.
    fn openssh_pem(pair: &key::KeyPair) -> String {
        let key::KeyPair::Ed25519(signing) = pair else { panic!("the fixture is ed25519") };
        let secret = signing.to_keypair_bytes();
        let public_blob = pair.clone_public_key().unwrap().public_key_bytes();

        let mut private = Vec::new();
        private.extend_from_slice(&[7, 7, 7, 7, 7, 7, 7, 7]);
        ssh_string(&mut private, b"ssh-ed25519");
        ssh_string(&mut private, &secret[32..]);
        ssh_string(&mut private, &secret);
        ssh_string(&mut private, b"sail-mast:ada");
        for pad in 1u8.. {
            if private.len() % 8 == 0 {
                break;
            }
            private.push(pad);
        }

        let mut blob = b"openssh-key-v1\0".to_vec();
        ssh_string(&mut blob, b"none");
        ssh_string(&mut blob, b"none");
        ssh_string(&mut blob, b"");
        blob.extend_from_slice(&1u32.to_be_bytes());
        ssh_string(&mut blob, &public_blob);
        ssh_string(&mut blob, &private);

        let body = base64(&blob, STD_ALPHABET, true);
        let lines: Vec<&str> = body.as_bytes().chunks(70).map(|line| std::str::from_utf8(line).unwrap()).collect();
        format!("-----BEGIN OPENSSH PRIVATE KEY-----\n{}\n-----END OPENSSH PRIVATE KEY-----\n", lines.join("\n"))
    }

    fn host_key_line(pair: &key::KeyPair) -> String {
        format!("ssh-ed25519 {}", pair.clone_public_key().unwrap().public_key_base64())
    }

    fn encode(fields: &Value) -> String {
        format!("sail1.{}", base64(fields.to_string().as_bytes(), URL_ALPHABET, false))
    }

    /// The fields of a code for a box at 127.0.0.1:`port`, as `sail fde pair` emits them.
    fn code_fields(port: u16, host_key: &key::KeyPair, client_key: &key::KeyPair) -> Value {
        json!({
            "v": 1,
            "handle": "ada",
            "email": "ada@example.com",
            "host": "127.0.0.1",
            "port": port,
            "user": "root",
            "host_key": host_key_line(host_key),
            "key": openssh_pem(client_key),
            "token": TOKEN,
            "server": "http://127.0.0.1:7070",
        })
    }

    fn fresh_key() -> key::KeyPair {
        key::KeyPair::generate_ed25519().unwrap()
    }

    fn sample_fields() -> Value {
        code_fields(22, &fresh_key(), &fresh_key())
    }

    fn sentence(text: &str) -> String {
        ConnectCode::parse(text).err().expect("the code is refused").to_string()
    }

    struct TempHome(PathBuf);

    impl TempHome {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!(
                "mast-pairing-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            TempHome(dir)
        }

        fn path(&self, relative: &str) -> PathBuf {
            self.0.join(relative)
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn a_valid_code_names_who_and_where() {
        let code = ConnectCode::parse(&encode(&sample_fields())).ok().expect("parses");
        assert_eq!(
            code.preview(),
            CodePreview { handle: "ada".into(), email: Some("ada@example.com".into()), host: "127.0.0.1".into() }
        );
        assert_eq!((code.pairing.port, code.pairing.user.as_str()), (22, "root"));
    }

    #[test]
    fn a_code_wrapped_by_the_terminal_it_was_copied_from_still_parses() {
        let code = encode(&sample_fields());
        let (head, tail) = code.split_at(80);
        let wrapped = format!("  {head}\n{}\r\n", tail.replace("A", "A "));
        assert!(ConnectCode::parse(&wrapped).is_ok());
    }

    #[test]
    fn a_code_without_an_email_names_the_handle_alone() {
        for email in [Value::Null, json!("")] {
            let mut fields = sample_fields();
            fields["email"] = email;
            assert_eq!(ConnectCode::parse(&encode(&fields)).ok().unwrap().preview().email, None);
        }
        let mut fields = sample_fields();
        fields.as_object_mut().unwrap().remove("email");
        assert!(ConnectCode::parse(&encode(&fields)).is_ok());
    }

    #[test]
    fn a_bad_code_says_why_in_one_sentence() {
        let valid = encode(&sample_fields());
        let body = valid.strip_prefix("sail1.").unwrap();
        assert_eq!(sentence(body), NOT_A_CODE);
        assert_eq!(sentence("hello"), NOT_A_CODE);
        assert_eq!(sentence(&format!("sail2.{body}")), NOT_A_CODE);
        assert_eq!(sentence(&format!("sail1.{body}*")), DAMAGED);
        assert_eq!(sentence(&format!("sail1.{}", &body[..(body.len() / 4 - 2) * 4])), NOT_SETTINGS);
        assert_eq!(sentence(&format!("sail1.{}", &body[..(body.len() / 4 - 2) * 4 + 1])), DAMAGED);
        assert_eq!(sentence("sail1.A"), DAMAGED);
        assert_eq!(sentence(&format!("sail1.{}", base64(b"not json", URL_ALPHABET, false))), NOT_SETTINGS);
        assert_eq!(sentence(&format!("sail1.{}", base64(b"[1]", URL_ALPHABET, false))), NOT_SETTINGS);

        let mut newer = sample_fields();
        newer["v"] = json!(2);
        assert_eq!(sentence(&encode(&newer)), NEWER_CODE);

        let mut unreadable = sample_fields();
        unreadable["key"] = json!("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n");
        assert_eq!(sentence(&encode(&unreadable)), BAD_KEY);
    }

    #[test]
    fn a_code_missing_a_field_names_the_field() {
        for (field, label) in [
            ("v", "version"),
            ("handle", "handle"),
            ("host", "host"),
            ("port", "port"),
            ("user", "user"),
            ("host_key", "host key"),
            ("key", "key"),
            ("token", "token"),
            ("server", "server"),
        ] {
            let mut fields = sample_fields();
            fields.as_object_mut().unwrap().remove(field);
            assert_eq!(
                sentence(&encode(&fields)),
                format!("This connect code is missing its {label}; ask for a new one."),
            );
        }
    }

    #[test]
    fn a_field_that_could_break_out_of_a_path_a_header_or_a_file_is_refused() {
        for (field, value, label) in [
            ("host", json!("box/../../etc"), "host"),
            ("handle", json!("../ada"), "handle"),
            ("user", json!("root\nProxyCommand evil"), "user"),
            ("token", json!("tok\r\nX-Injected: 1"), "token"),
            ("server", json!("https://example.com"), "server"),
            ("server", json!("http://127.0.0.1:7070/\r\nHost: x"), "server"),
            ("port", json!(70000), "port"),
            ("port", json!("22"), "port"),
            ("host_key", json!("ssh-ed25519 not-a-key"), "host key"),
        ] {
            let mut fields = sample_fields();
            fields[field] = value;
            assert_eq!(
                sentence(&encode(&fields)),
                format!("This connect code's {label} is not valid; ask for a new one."),
            );
        }
    }

    #[test]
    fn no_refusal_quotes_the_code_the_token_or_the_key() {
        let mut fields = sample_fields();
        fields["user"] = json!("not a login");
        let code = encode(&fields);
        let refusal = sentence(&code);
        let key = fields["key"].as_str().unwrap().lines().nth(1).unwrap().to_string();
        for secret in [TOKEN, key.as_str(), &code[6..40]] {
            assert!(!refusal.contains(secret), "{refusal}");
        }
    }

    #[test]
    fn base64url_decodes_every_tail_length_and_refuses_what_is_not_base64url() {
        for text in ["", "f", "fo", "foo", "foob", "fooba", "foobar"] {
            let encoded = base64(text.as_bytes(), URL_ALPHABET, false);
            assert_eq!(base64url(&encoded).as_deref(), Some(text.as_bytes()), "{text}");
            assert_eq!(base64url(&base64(text.as_bytes(), URL_ALPHABET, true)).as_deref(), Some(text.as_bytes()));
        }
        assert_eq!(base64url("-_-_").unwrap(), [0xfb, 0xff, 0xbf]);
        for bad in ["Zm9v+g", "Zm9v/g", "Zm 9v", "Z"] {
            assert_eq!(base64url(bad), None, "{bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn what_a_code_carries_is_stored_owner_only_and_read_back() {
        let home = TempHome::new();
        let (host_key, client_key) = (fresh_key(), fresh_key());
        let code = ConnectCode::parse(&encode(&code_fields(2222, &host_key, &client_key))).ok().unwrap();
        store(&home.0, &code).unwrap();

        let key_path = home.path(".sail/keys/127.0.0.1-ada");
        assert_eq!(mode(&home.path(SETTINGS_FILE)), 0o600);
        assert_eq!(mode(&key_path), 0o600);
        assert_eq!(mode(&home.path(KEYS_DIR)), 0o700);
        let written = parse_yaml(&std::fs::read_to_string(home.path(SETTINGS_FILE)).unwrap());
        for (name, value) in [
            ("host", "127.0.0.1"),
            ("port", "2222"),
            ("user", "root"),
            ("host_key", host_key_line(&host_key).as_str()),
            ("key_path", key_path.to_str().unwrap()),
            ("token", TOKEN),
            ("server", "http://127.0.0.1:7070"),
            ("handle", "ada"),
            ("email", "ada@example.com"),
        ] {
            assert_eq!(written.get(name).map(String::as_str), Some(value), "{name}");
        }

        let settings = ConnectionSettings::load(&home.0).ok().unwrap();
        let Route::Paired(pairing) = &settings.route else { panic!("mast.yaml is the route") };
        assert_eq!((pairing.host.as_str(), pairing.port, pairing.user.as_str()), ("127.0.0.1", 2222, "root"));
        assert_eq!(pairing.host_key, host_key.clone_public_key().unwrap());
        assert_eq!(pairing.key.clone_public_key().unwrap(), client_key.clone_public_key().unwrap());
        assert_eq!((settings.server_host.as_str(), settings.server_port), ("127.0.0.1", 7070));
        assert_eq!(settings.token.as_deref(), Some(TOKEN));
    }

    #[test]
    fn a_mac_with_no_settings_at_all_is_unpaired_not_broken() {
        let home = TempHome::new();
        assert!(matches!(ConnectionSettings::load(&home.0), Err(Error::Unpaired)));
    }

    #[test]
    fn a_mast_yaml_that_cannot_be_used_is_an_error_and_never_falls_back() {
        let home = TempHome::new();
        std::fs::create_dir_all(home.path(".sail")).unwrap();
        std::fs::write(home.path(".sail/config.yaml"), "host: devbox\n").unwrap();
        std::fs::write(home.path(SETTINGS_FILE), "host: 127.0.0.1\nport: 22\n").unwrap();
        let refusal = ConnectionSettings::load(&home.0).err().unwrap();
        assert!(matches!(refusal, Error::BadPairing(_)));
        assert_eq!(
            refusal.to_string(),
            "Mast's saved connection to its box cannot be used (mast.yaml has no host_key); forget this box and paste a new connect code."
        );
    }

    #[test]
    fn forgetting_deletes_the_settings_and_the_key_and_nothing_else() {
        let home = TempHome::new();
        let code = ConnectCode::parse(&encode(&sample_fields())).ok().unwrap();
        store(&home.0, &code).unwrap();
        std::fs::write(home.path(".sail/config.yaml"), "host: devbox\n").unwrap();

        forget(&home.0).unwrap();
        assert!(!home.path(SETTINGS_FILE).exists());
        assert!(!home.path(".sail/keys/127.0.0.1-ada").exists());
        assert!(home.path(".sail/config.yaml").exists());
        forget(&home.0).expect("forgetting twice changes nothing");

        let outside = home.path("id_ed25519");
        std::fs::write(&outside, "someone else's key").unwrap();
        std::fs::write(home.path(SETTINGS_FILE), format!("key_path: {}\n", outside.display())).unwrap();
        forget(&home.0).unwrap();
        assert!(outside.exists(), "only a key under ~/.sail/keys is Mast's to delete");
        assert!(!home.path(SETTINGS_FILE).exists());

        std::fs::write(home.path(SETTINGS_FILE), format!("key_path: {}/..\n", home.path(KEYS_DIR).display())).unwrap();
        forget(&home.0).expect("a path that names no file is nothing to delete");
        assert!(home.path(KEYS_DIR).exists());
    }

    #[test]
    fn a_home_that_moved_still_finds_and_forgets_its_key() {
        let (before, after) = (TempHome::new(), TempHome::new());
        store(&before.0, &ConnectCode::parse(&encode(&sample_fields())).ok().unwrap()).unwrap();
        std::fs::remove_dir(&after.0).unwrap();
        std::fs::rename(&before.0, &after.0).unwrap();

        assert!(ConnectionSettings::load(&after.0).ok().unwrap().paired());
        forget(&after.0).unwrap();
        assert!(!after.path(".sail/keys/127.0.0.1-ada").exists());
    }

    #[test]
    fn a_pairing_that_cannot_be_saved_leaves_the_one_before_it_whole_and_no_key_behind() {
        let home = TempHome::new();
        store(&home.0, &ConnectCode::parse(&encode(&sample_fields())).ok().unwrap()).unwrap();
        let before = std::fs::read_to_string(home.path(SETTINGS_FILE)).unwrap();
        let mut other = sample_fields();
        other["handle"] = json!("grace");
        std::fs::create_dir(home.path(".sail/keys/127.0.0.1-grace")).unwrap();

        assert!(store(&home.0, &ConnectCode::parse(&encode(&other)).ok().unwrap()).is_err());
        assert_eq!(std::fs::read_to_string(home.path(SETTINGS_FILE)).unwrap(), before);
        assert!(ConnectionSettings::load(&home.0).ok().unwrap().paired());

        let fresh = TempHome::new();
        std::fs::create_dir_all(fresh.path(SETTINGS_FILE)).unwrap();
        assert!(store(&fresh.0, &ConnectCode::parse(&encode(&sample_fields())).ok().unwrap()).is_err());
        assert!(!fresh.path(".sail/keys/127.0.0.1-ada").exists());
    }

    #[test]
    fn pairing_again_removes_the_key_of_the_pairing_it_replaces() {
        let home = TempHome::new();
        store(&home.0, &ConnectCode::parse(&encode(&sample_fields())).ok().unwrap()).unwrap();
        let mut other = sample_fields();
        other["handle"] = json!("grace");
        store(&home.0, &ConnectCode::parse(&encode(&other)).ok().unwrap()).unwrap();
        assert!(!home.path(".sail/keys/127.0.0.1-ada").exists());
        assert!(home.path(".sail/keys/127.0.0.1-grace").exists());
    }

    fn response(status: u16, body: Value) -> SailResponse {
        SailResponse { status, etag: None, body: body.to_string() }
    }

    fn refusal(status: u16, code: &str, message: &str) -> SailResponse {
        response(status, json!({ "schema_version": 1, "error": { "code": code, "message": message } }))
    }

    fn connect_body(key_set: bool) -> Value {
        json!({
            "project": "alpha",
            "server_ip": "203.0.113.7",
            "server_user": "someone-else",
            "container_ip": CONTAINER_IP,
            "container_user": "dev",
            "workstation_key_set": key_set,
        })
    }

    #[test]
    fn the_hop_to_a_container_is_the_response_s_container_and_never_its_server() {
        let hop = ContainerHop::from_response("alpha", &response(200, connect_body(true))).unwrap();
        assert_eq!(hop, ContainerHop { ip: CONTAINER_IP.into(), user: "dev".into() });
        assert_eq!(connect_path("alpha").unwrap(), "/v1/projects/alpha/connect");
    }

    #[test]
    fn a_container_that_cannot_be_reached_says_why_in_the_box_s_words() {
        let stopped = refusal(409, "project_stopped", "Project 'beta' is stopped.");
        assert_eq!(
            ContainerHop::from_response("beta", &stopped).unwrap_err().to_string(),
            "Project 'beta' is stopped."
        );
        assert_eq!(
            ContainerHop::from_response("alpha", &response(200, connect_body(false))).unwrap_err().to_string(),
            "alpha's container does not trust this Mac's key yet; the box owner must re-apply the project before its files open."
        );
        assert_eq!(
            ContainerHop::from_response("alpha", &SailResponse { status: 502, etag: None, body: String::new() })
                .unwrap_err()
                .to_string(),
            "The box answered HTTP 502 when asked for alpha's container."
        );
        let mut hostile = connect_body(true);
        hostile["container_ip"] = json!("10.0.0.1 -oProxyCommand=evil");
        assert!(matches!(ContainerHop::from_response("alpha", &response(200, hostile)), Err(Error::BadResponse)));
    }

    #[test]
    fn a_project_name_that_would_rewrite_the_request_is_refused() {
        for hostile in ["", ".", "..", "a/b", "alpha HTTP/1.1\r\nX: y", "../whoami", "a?b"] {
            assert!(matches!(connect_path(hostile), Err(Error::Refused(_))), "{hostile}");
        }
    }

    #[derive(Default)]
    struct Seen {
        auth_attempts: AtomicUsize,
        container_logins: StdMutex<Vec<String>>,
    }

    /// A box in this process: an SSH server with a known host key that lets one public key in
    /// as `root`, forwards `127.0.0.1:7070` to a stub API, and forwards the container address to
    /// a second SSH server standing in for a project container.
    struct FakeBox {
        port: u16,
        host_key: Arc<StdMutex<key::KeyPair>>,
        client_key: key::KeyPair,
        seen: Arc<Seen>,
    }

    impl FakeBox {
        async fn start() -> Self {
            let host_key = Arc::new(StdMutex::new(fresh_key()));
            let client_key = fresh_key();
            let seen = Arc::new(Seen::default());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let handler = BoxHandler {
                authorized: client_key.clone_public_key().unwrap(),
                seen: seen.clone(),
            };
            let presented = host_key.clone();
            tokio::spawn(async move {
                while let Ok((socket, _)) = listener.accept().await {
                    let config = server_config(presented.lock().unwrap().clone());
                    tokio::spawn(serve_ssh(config, socket, handler.clone()));
                }
            });
            FakeBox { port, host_key, client_key, seen }
        }

        fn fields(&self) -> Value {
            code_fields(self.port, &self.host_key.lock().unwrap(), &self.client_key)
        }

        fn code(&self) -> String {
            encode(&self.fields())
        }

        fn rotate_host_key(&self) {
            *self.host_key.lock().unwrap() = fresh_key();
        }

        fn auth_attempts(&self) -> usize {
            self.seen.auth_attempts.load(Ordering::Relaxed)
        }
    }

    fn server_config(host_key: key::KeyPair) -> Arc<server::Config> {
        Arc::new(server::Config {
            keys: vec![host_key],
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            ..Default::default()
        })
    }

    async fn serve_ssh<S, H>(config: Arc<server::Config>, stream: S, handler: H)
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
        H: server::Handler + Send + 'static,
    {
        if let Ok(session) = server::run_stream(config, stream, handler).await {
            let _ = session.await;
        }
    }

    fn admit(allowed: bool) -> Auth {
        if allowed {
            Auth::Accept
        } else {
            Auth::Reject { proceed_with_methods: None }
        }
    }

    #[derive(Clone)]
    struct BoxHandler {
        authorized: key::PublicKey,
        seen: Arc<Seen>,
    }

    #[async_trait]
    impl server::Handler for BoxHandler {
        type Error = russh::Error;

        async fn auth_none(&mut self, _user: &str) -> Result<Auth, Self::Error> {
            self.seen.auth_attempts.fetch_add(1, Ordering::Relaxed);
            Ok(admit(false))
        }

        async fn auth_publickey_offered(&mut self, user: &str, offered: &key::PublicKey) -> Result<Auth, Self::Error> {
            self.seen.auth_attempts.fetch_add(1, Ordering::Relaxed);
            Ok(admit(user == "root" && *offered == self.authorized))
        }

        async fn auth_publickey(&mut self, user: &str, proven: &key::PublicKey) -> Result<Auth, Self::Error> {
            self.seen.auth_attempts.fetch_add(1, Ordering::Relaxed);
            Ok(admit(user == "root" && *proven == self.authorized))
        }

        async fn channel_open_direct_tcpip(
            &mut self,
            channel: Channel<Msg>,
            host: &str,
            port: u32,
            _originator: &str,
            _originator_port: u32,
            _session: &mut Session,
        ) -> Result<bool, Self::Error> {
            match (host, port) {
                ("127.0.0.1", 7070) => {
                    tokio::spawn(serve_api(channel));
                    Ok(true)
                }
                (CONTAINER_IP, 22) => {
                    let container = ContainerHandler { authorized: self.authorized.clone(), seen: self.seen.clone() };
                    tokio::spawn(serve_ssh(server_config(fresh_key()), channel.into_stream(), container));
                    Ok(true)
                }
                _ => Ok(false),
            }
        }
    }

    struct ContainerHandler {
        authorized: key::PublicKey,
        seen: Arc<Seen>,
    }

    #[async_trait]
    impl server::Handler for ContainerHandler {
        type Error = russh::Error;

        async fn auth_publickey(&mut self, user: &str, proven: &key::PublicKey) -> Result<Auth, Self::Error> {
            self.seen.container_logins.lock().unwrap().push(user.to_string());
            Ok(admit(user == "dev" && *proven == self.authorized))
        }

        async fn channel_open_session(&mut self, _channel: Channel<Msg>, _session: &mut Session) -> Result<bool, Self::Error> {
            Ok(true)
        }

        async fn exec_request(&mut self, channel: ChannelId, _command: &[u8], session: &mut Session) -> Result<(), Self::Error> {
            session.channel_success(channel);
            session.exit_status_request(channel, 0);
            session.close(channel);
            Ok(())
        }
    }

    /// The box's API, answered on the forwarded channel: one request, one response, then EOF.
    async fn serve_api(channel: Channel<Msg>) {
        let mut stream = channel.into_stream();
        let mut request = Vec::new();
        let mut chunk = [0u8; 1024];
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            match stream.read(&mut chunk).await {
                Ok(n) if n > 0 => request.extend_from_slice(&chunk[..n]),
                _ => break,
            }
        }
        let (status, body) = answer(&String::from_utf8_lossy(&request));
        let body = body.to_string();
        let response = format!(
            "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.shutdown().await;
    }

    fn answer(request: &str) -> (u16, Value) {
        let error = |code: &str, message: &str| json!({ "schema_version": 1, "error": { "code": code, "message": message } });
        if !request.contains(&format!("Authorization: Bearer {TOKEN}\r\n")) {
            return (403, error("invalid_bearer_token", "Bearer token is invalid."));
        }
        match request.split_whitespace().nth(1).unwrap_or_default() {
            "/v1/whoami" => (
                200,
                json!({ "fde": "ada", "name": "mast-ada", "role": "member", "capabilities": [], "email": "ada@example.com" }),
            ),
            "/v1/projects" => (
                200,
                json!({ "projects": [
                    { "name": "alpha", "container_status": "running" },
                    { "name": "beta", "container_status": "stopped" },
                    { "name": "gamma", "container_status": "running" },
                ] }),
            ),
            "/v1/projects/alpha/connect" => (200, connect_body(true)),
            "/v1/projects/beta/connect" => (409, error("project_stopped", "Project 'beta' is stopped.")),
            "/v1/projects/gamma/connect" => (200, connect_body(false)),
            _ => (404, error("not_found", "No route.")),
        }
    }

    /// An `~/.ssh/config` that would send any dial somewhere dead and name a project of its own,
    /// so a paired path that consulted it could neither connect nor list what the box lists.
    fn poison_ssh_config(home: &TempHome) {
        std::fs::create_dir_all(home.path(".ssh")).unwrap();
        std::fs::write(
            home.path(".ssh/config"),
            "Host *\n  HostName 203.0.113.1\n  Port 1\n\nHost from-ssh-config\n  ProxyJump nowhere\n",
        )
        .unwrap();
    }

    async fn whoami(backend: &Backend) -> Value {
        let response = backend.sail_request("GET", "/v1/whoami", None, None).await.unwrap();
        assert_eq!(response.status, 200);
        serde_json::from_str(&response.body).unwrap()
    }

    async fn refused(home: &TempHome, code: &str) -> String {
        pair(&home.0, code).await.err().expect("the connection is refused").to_string()
    }

    async fn relaunch(home: &TempHome) -> Value {
        let loaded = ConnectionSettings::load(&home.0).map(|settings| Arc::new(Backend::new(settings)));
        connection_status(loaded).await
    }

    #[tokio::test]
    async fn a_fresh_mac_launches_unpaired_and_names_no_file() {
        let status = relaunch(&TempHome::new()).await;
        assert_eq!(status["phase"], "unpaired");
        assert_eq!(status["paired"], false);
        assert!(status["detail"].is_null(), "{status}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn connecting_with_a_code_proves_the_box_then_writes_the_settings() {
        let (home, fake) = (TempHome::new(), FakeBox::start().await);
        let backend = pair(&home.0, &fake.code()).await.ok().expect("the fake box takes the code");

        assert_eq!(whoami(&backend).await["email"], "ada@example.com");
        assert!(fake.auth_attempts() > 0, "the box saw the paired key offered");
        assert_eq!(mode(&home.path(SETTINGS_FILE)), 0o600);
        assert_eq!(mode(&home.path(".sail/keys/127.0.0.1-ada")), 0o600);
        assert!(!home.path(".sail/config.yaml").exists());
        assert!(!home.path(".ssh").exists(), "nothing else on the Mac is needed or made");
    }

    #[tokio::test]
    async fn a_box_with_another_host_key_is_refused_before_authentication_and_nothing_is_written() {
        let (home, fake) = (TempHome::new(), FakeBox::start().await);
        let mut fields = fake.fields();
        fields["host_key"] = json!(host_key_line(&fresh_key()));

        assert_eq!(
            refused(&home, &encode(&fields)).await,
            "The box at 127.0.0.1 answered with a different host key than the one in its connect code, so Mast refused it; pair again with a new code."
        );
        assert_eq!(fake.auth_attempts(), 0, "the key is checked before any identity is offered");
        assert!(!home.path(".sail").exists());
    }

    #[tokio::test]
    async fn a_token_the_box_refuses_says_so_in_the_box_s_words_and_nothing_is_written() {
        let (home, fake) = (TempHome::new(), FakeBox::start().await);
        let mut fields = fake.fields();
        fields["token"] = json!("sail_tok_revoked");

        let sentence = refused(&home, &encode(&fields)).await;
        assert_eq!(sentence, "The box at 127.0.0.1 refused this code (Bearer token is invalid); ask for a new one.");
        assert!(!sentence.contains("sail_tok_revoked"));
        assert!(!home.path(".sail").exists());
    }

    #[tokio::test]
    async fn a_key_the_box_does_not_know_is_refused_in_the_paired_path_s_own_words() {
        let (home, fake) = (TempHome::new(), FakeBox::start().await);
        let mut fields = fake.fields();
        fields["key"] = json!(openssh_pem(&fresh_key()));

        let sentence = refused(&home, &encode(&fields)).await;
        assert_eq!(sentence, "The box at 127.0.0.1 no longer accepts this Mac's key; ask for a new connect code.");
        assert!(!home.path(".sail").exists());
    }

    #[tokio::test]
    async fn a_host_that_does_not_answer_says_so_without_naming_a_file_on_the_mac() {
        let home = TempHome::new();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let sentence = refused(&home, &encode(&code_fields(port, &fresh_key(), &fresh_key()))).await;
        assert_eq!(sentence, "127.0.0.1 did not answer; check that the box is running and this Mac is online.");
        for fallback_word in ["~/.ssh/config", "ssh-add", "id_ed25519", "config.yaml"] {
            assert!(!sentence.contains(fallback_word), "{sentence}");
        }
        assert!(!home.path(".sail").exists());
    }

    #[tokio::test]
    async fn a_relaunch_connects_from_mast_yaml_and_never_reads_the_ssh_config() {
        let (home, fake) = (TempHome::new(), FakeBox::start().await);
        pair(&home.0, &fake.code()).await.ok().unwrap();
        poison_ssh_config(&home);

        let status = relaunch(&home).await;
        assert_eq!(status["phase"], "ready", "{status}");
        assert_eq!((&status["paired"], &status["sshHost"]), (&json!(true), &json!("127.0.0.1")));

        let backend = Backend::new(ConnectionSettings::load(&home.0).ok().unwrap());
        assert_eq!(whoami(&backend).await["fde"], "ada");
        assert_eq!(backend.list_targets().await.unwrap(), ["alpha", "beta", "gamma"]);
    }

    #[tokio::test]
    async fn a_host_key_that_changed_since_pairing_is_refused_on_relaunch() {
        let (home, fake) = (TempHome::new(), FakeBox::start().await);
        pair(&home.0, &fake.code()).await.ok().unwrap();
        fake.rotate_host_key();
        let attempts = fake.auth_attempts();

        let status = relaunch(&home).await;
        assert_eq!(status["phase"], "unpaired");
        assert_eq!(
            status["detail"],
            "The box at 127.0.0.1 answered with a different host key than the one in its connect code, so Mast refused it; pair again with a new code."
        );
        assert_eq!((&status["paired"], &status["sshHost"]), (&json!(true), &json!("127.0.0.1")));
        assert_eq!(fake.auth_attempts(), attempts, "refused before authentication");
        assert!(home.path(SETTINGS_FILE).exists());
    }

    #[tokio::test]
    async fn the_file_workbench_hops_to_a_container_through_the_paired_box_with_the_paired_key() {
        let (home, fake) = (TempHome::new(), FakeBox::start().await);
        let backend = pair(&home.0, &fake.code()).await.ok().unwrap();
        poison_ssh_config(&home);

        let (exit, _) = backend.exec_capture("alpha", "true").await.expect("a channel on the container");
        assert_eq!(exit, 0);
        assert_eq!(*fake.seen.container_logins.lock().unwrap(), ["dev"]);

        assert_eq!(
            backend.fs_list("beta", None).await.err().unwrap().to_string(),
            "Project 'beta' is stopped."
        );
        assert_eq!(
            backend.fs_list("gamma", None).await.err().unwrap().to_string(),
            "gamma's container does not trust this Mac's key yet; the box owner must re-apply the project before its files open."
        );
    }

    #[tokio::test]
    async fn a_token_revoked_while_running_keeps_mast_yaml_and_returns_to_the_first_run_screen() {
        let (home, fake) = (TempHome::new(), FakeBox::start().await);
        let backend = Arc::new(pair(&home.0, &fake.code()).await.ok().unwrap());
        let stored = std::fs::read_to_string(home.path(SETTINGS_FILE)).unwrap();

        backend.token_refused().await.unwrap();

        let status = connection_status(Ok(backend)).await;
        assert_eq!(status["phase"], "unpaired");
        assert_eq!(status["detail"], REVOKED);
        assert_eq!((&status["paired"], &status["sshHost"]), (&json!(true), &json!("127.0.0.1")));
        assert_eq!(std::fs::read_to_string(home.path(SETTINGS_FILE)).unwrap(), stored);
        assert!(!home.path(".sail/config.yaml").exists());
    }

    #[tokio::test]
    async fn a_paired_mac_keeps_its_token_in_mast_yaml() {
        let (home, fake) = (TempHome::new(), FakeBox::start().await);
        let backend = pair(&home.0, &fake.code()).await.ok().unwrap();

        backend.set_token(Some("sail_tok_next".into())).await.unwrap();
        assert_eq!(ConnectionSettings::load(&home.0).ok().unwrap().token.as_deref(), Some("sail_tok_next"));
        backend.set_token(None).await.unwrap();
        assert_eq!(ConnectionSettings::load(&home.0).ok().unwrap().token, None);
        assert!(!home.path(".sail/config.yaml").exists());
    }

    #[tokio::test]
    async fn forgetting_the_box_returns_the_mac_to_its_first_run() {
        let (home, fake) = (TempHome::new(), FakeBox::start().await);
        pair(&home.0, &fake.code()).await.ok().unwrap();
        forget(&home.0).unwrap();
        assert_eq!(relaunch(&home).await["phase"], "unpaired");
    }

    #[tokio::test]
    async fn a_mac_with_only_the_cli_s_settings_takes_the_ssh_config_path_as_before() {
        let home = TempHome::new();
        std::fs::create_dir_all(home.path(".sail")).unwrap();
        std::fs::create_dir_all(home.path(".ssh")).unwrap();
        std::fs::write(home.path(".sail/config.yaml"), "{host: devbox, user: uday, server: 'http://localhost:7070'}\n").unwrap();
        std::fs::write(
            home.path(".ssh/config"),
            "Host devbox\n  HostName 10.0.0.5\n\nHost alpha\n  ProxyJump devbox\n",
        )
        .unwrap();

        let settings = ConnectionSettings::load(&home.0).ok().unwrap();
        assert!(matches!(&settings.route, Route::SshConfig { alias, fallback_user, .. }
            if alias == "devbox" && fallback_user.as_deref() == Some("uday")));
        let backend = Arc::new(Backend::new(settings));
        assert_eq!(backend.list_targets().await.unwrap(), ["alpha"]);

        let status = connection_status(Ok(backend.clone())).await;
        assert_eq!((&status["phase"], &status["paired"]), (&json!("unauthenticated"), &json!(false)));

        backend.set_token(Some("sess_abc".into())).await.unwrap();
        assert_eq!(ConnectionSettings::load(&home.0).ok().unwrap().token.as_deref(), Some("sess_abc"));
        backend.token_refused().await.unwrap();
        assert_eq!(ConnectionSettings::load(&home.0).ok().unwrap().token, None);
        assert!(!home.path(SETTINGS_FILE).exists());
    }
}
