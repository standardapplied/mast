//! The portal: one click brings a project's stack up, forwards its ports to this Mac and names
//! the address to open.
//!
//! The box does the bringing up (`POST /v1/projects/{p}/serve`) and says where each declared port
//! stands; Mast forwards each one that listens, over the container's session, from this Mac's
//! loopback. A serve is asked to wait no longer than a request may, and a port still starting is
//! looked at again (`GET …/ports`) until it settles, so the sheet fills in as the stack comes up.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

use crate::forward::{Connect, Duplex};
use crate::pairing;
use crate::ssh::{Backend, Error};

/// How long a serve asks the box to wait, well under the core's per-request limit: the sheet
/// looks again until the stack settles.
const SERVE_WAIT_SECONDS: u32 = 5;

/// One declared port of the project, and the Mac's end of it when it is forwarded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortalPort {
    pub name: String,
    pub port: u16,
    pub kind: String,
    pub state: String,
    pub exit_code: Option<i64>,
    pub detail: Option<String>,
    pub local_port: Option<u16>,
}

/// Where the project's stack stands, and the address to open: the first process that listens,
/// else none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortalView {
    pub project: String,
    pub ports: Vec<PortalPort>,
    pub url: Option<String>,
    pub settled: bool,
}

/// Brings the project's stack up and forwards every port that listens.
pub async fn open(backend: &Arc<Backend>, project: &str) -> Result<PortalView, Error> {
    let path = format!(
        "{}?timeout={SERVE_WAIT_SECONDS}",
        pairing::project_path(project, "serve")?
    );
    let answer = backend.sail_request("POST", &path, None, None).await?;
    view(
        backend,
        project,
        &pairing::answered(&answer, "to bring the project up")?,
    )
    .await
}

/// Where the project's ports stand now, forwarding any that came to listen.
pub async fn refresh(backend: &Arc<Backend>, project: &str) -> Result<PortalView, Error> {
    let path = pairing::project_path(project, "ports")?;
    let answer = backend.sail_request("GET", &path, None, None).await?;
    view(
        backend,
        project,
        &pairing::answered(&answer, "where the project's ports stand")?,
    )
    .await
}

/// Stops the project's processes and closes its forwards; its services keep running.
pub async fn stop(backend: &Arc<Backend>, project: &str) -> Result<PortalView, Error> {
    let path = pairing::project_path(project, "serve")?;
    let answer = backend.sail_request("DELETE", &path, None, None).await?;
    let body = pairing::answered(&answer, "to stop the project's processes")?;
    backend.forwards().close(project).await;
    Ok(read(project, &body, &Default::default()))
}

async fn view(backend: &Arc<Backend>, project: &str, body: &Value) -> Result<PortalView, Error> {
    for port in listening(body) {
        backend
            .forwards()
            .open(project, port, connect(backend.clone(), project.to_string()))
            .await
            .map_err(|refused| Error::Refused(format!("Port {port}: {refused}.")))?;
    }
    Ok(read(project, body, &backend.forwards().of(project).await))
}

fn connect(backend: Arc<Backend>, project: String) -> Connect {
    Arc::new(move |port| {
        let backend = backend.clone();
        let project = project.clone();
        Box::pin(async move {
            let channel = backend
                .container_port(&project, port)
                .await
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            Ok(Box::new(channel.into_stream()) as Box<dyn Duplex>)
        })
    })
}

/// The ports the box says listen.
fn listening(body: &Value) -> Vec<u16> {
    ports(body)
        .filter(|port| port.get("state").and_then(Value::as_str) == Some("listening"))
        .filter_map(|port| port.get("port").and_then(Value::as_u64))
        .filter_map(|port| u16::try_from(port).ok())
        .collect()
}

fn ports(body: &Value) -> impl Iterator<Item = &Value> {
    body.get("ports")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

/// The box's answer as the sheet shows it, each port with the Mac's end of its forward.
fn read(project: &str, body: &Value, forwarded: &HashMap<u16, u16>) -> PortalView {
    let ports: Vec<PortalPort> = ports(body)
        .filter_map(|port| {
            let number = u16::try_from(port.get("port")?.as_u64()?).ok()?;
            Some(PortalPort {
                name: port.get("name")?.as_str()?.to_string(),
                port: number,
                kind: port
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("process")
                    .to_string(),
                state: port
                    .get("state")
                    .and_then(Value::as_str)
                    .unwrap_or("stopped")
                    .to_string(),
                exit_code: port.get("exit_code").and_then(Value::as_i64),
                detail: port
                    .get("detail")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                local_port: forwarded.get(&number).copied(),
            })
        })
        .collect();
    let url = ports
        .iter()
        .find(|port| port.kind == "process" && port.local_port.is_some())
        .map(|port| format!("http://127.0.0.1:{}", port.local_port.unwrap()));
    let settled = ports.iter().all(|port| port.state != "starting" && port.state != "timeout");
    PortalView {
        project: project.to_string(),
        ports,
        url,
        settled,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn answer() -> Value {
        json!({
            "project": "acme",
            "all_listening": false,
            "ports": [
                {"name": "postgres", "port": 5432, "kind": "service", "state": "listening",
                 "exit_code": null, "detail": null},
                {"name": "web", "port": 3000, "kind": "process", "state": "listening",
                 "exit_code": null, "detail": null},
                {"name": "worker", "port": 8080, "kind": "process", "state": "exited",
                 "exit_code": 1, "detail": "Error: Cannot find module 'bullmq'"}
            ]
        })
    }

    #[test]
    fn only_listening_ports_are_forwarded() {
        assert_eq!(listening(&answer()), vec![5432, 3000]);
        assert_eq!(listening(&json!({})), Vec::<u16>::new());
    }

    #[test]
    fn the_sheet_reads_each_port_with_its_forward_and_opens_the_first_process() {
        let view = read(
            "acme",
            &answer(),
            &HashMap::from([(5432, 5432), (3000, 3001)]),
        );

        assert_eq!(view.url.as_deref(), Some("http://127.0.0.1:3001"));
        assert!(view.settled);
        assert_eq!(
            view.ports[2],
            PortalPort {
                name: "worker".into(),
                port: 8080,
                kind: "process".into(),
                state: "exited".into(),
                exit_code: Some(1),
                detail: Some("Error: Cannot find module 'bullmq'".into()),
                local_port: None,
            }
        );
        assert_eq!(view.ports[1].local_port, Some(3001));
    }

    #[test]
    fn a_port_the_box_stopped_waiting_for_is_looked_at_again() {
        let slow = json!({"ports": [{"name": "web", "port": 8080, "kind": "process", "state": "timeout"}]});

        assert!(!read("acme", &slow, &HashMap::new()).settled);
    }

    #[test]
    fn with_no_process_listening_nothing_is_opened_and_a_starting_port_is_unsettled() {
        let starting = json!({"ports": [
            {"name": "postgres", "port": 5432, "kind": "service", "state": "listening"},
            {"name": "web", "port": 3000, "kind": "process", "state": "starting"}
        ]});

        let view = read("acme", &starting, &HashMap::from([(5432, 5432)]));

        assert_eq!(view.url, None);
        assert!(!view.settled);
    }

    #[test]
    fn a_port_entry_the_box_did_not_name_or_number_is_left_out() {
        let odd = json!({"ports": [{"port": 3000}, {"name": "web", "port": 70000}, {"name": "ok", "port": 1}]});

        assert_eq!(read("acme", &odd, &HashMap::new()).ports.len(), 1);
    }

    #[test]
    fn the_projects_requests_name_only_a_plain_project() {
        assert_eq!(
            pairing::project_path("acme", "serve").unwrap(),
            "/v1/projects/acme/serve"
        );
        assert!(pairing::project_path("acme/../x", "serve").is_err());
    }
}
