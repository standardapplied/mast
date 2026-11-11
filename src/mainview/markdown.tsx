import { memo, useEffect, useState, type ReactNode } from "react";
import { MENTION, opensMention } from "./board/mentions";
import { logError } from "./errorLog";
import { highlight, type HighlightedSpan } from "./tauri/editorSeam";
import { languageForFence } from "./tauri/fileKind";

/**
 * Minimal markdown renderer for spec bodies and room messages — headings, paragraphs, lists,
 * fenced code, blockquotes, and inline code/bold/italic/links. Deliberately dependency-free;
 * untrusted HTML is never injected (everything renders through React elements), and text the
 * subset does not define renders as typed. Links are plain anchors: the shell routes every one
 * to the Mac's browser (externalLinks.ts), so none opens in the webview.
 */

type Options = {
  /** A single line break is a line break, as a message is typed; a document's lines flow. */
  breaks: boolean;
  /** The reader's handle: a mention of them is marked. */
  me?: string;
};

const BARE_URL = String.raw`https?:\/\/[^\s<>()\[\]]*[^\s<>()\[\].,;:!?'"]`;

const INLINE = new RegExp(
  [
    "(?<code>`[^`]+`)",
    String.raw`(?<bold>\*\*[^*]+\*\*)`,
    String.raw`(?<em>\*[^*]+\*)`,
    String.raw`(?<link>\[(?<label>[^\]]+)\]\((?<href>[^)\s]+)\))`,
    `(?<url>${BARE_URL})`,
    `(?<mention>${MENTION.source})`,
  ].join("|"),
  "g",
);

const WEB_URL = /^https?:\/\//;

function inline(text: string, keyBase: string, options: Options): ReactNode[] {
  const mine = options.me ? `@${options.me}` : null;
  const nodes: ReactNode[] = [];
  let i = 0;
  const plain = (value: string) =>
    value.split("\n").forEach((line, index) => {
      if (index > 0) nodes.push(<br key={`${keyBase}-${i++}`} />);
      if (line) nodes.push(line);
    });
  let last = 0;

  for (const match of text.matchAll(INLINE)) {
    const { code, bold, em, link, label, href, url, mention } = match.groups!;
    const key = `${keyBase}-${i++}`;
    plain(text.slice(last, match.index));
    last = match.index + match[0].length;
    if (code) nodes.push(<code key={key}>{code.slice(1, -1)}</code>);
    else if (bold) nodes.push(<strong key={key}>{inline(bold.slice(2, -2), key, options)}</strong>);
    else if (em) nodes.push(<em key={key}>{inline(em.slice(1, -1), key, options)}</em>);
    else if (link && WEB_URL.test(href!)) nodes.push(<a key={key} href={href}>{label}</a>);
    else if (url) nodes.push(<a key={key} href={url}>{url}</a>);
    else if (mention === mine && opensMention(text, match.index)) {
      nodes.push(<span key={key} className="mention-me">{mention}</span>);
    } else plain(match[0]);
  }
  plain(text.slice(last));
  return nodes;
}

function CodeBlock({ code, tag }: { code: string; tag: string }) {
  const [spans, setSpans] = useState<HighlightedSpan[] | null>(null);
  const [copied, setCopied] = useState<"copied" | "copy failed" | null>(null);
  const language = languageForFence(tag);

  useEffect(() => {
    if (!language) return;
    let current = true;
    highlight(code, language).then(
      (next) => current && setSpans(next),
      (e: unknown) => logError("highlight", e instanceof Error ? e.message : String(e)),
    );
    return () => {
      current = false;
    };
  }, [code, language]);

  const copy = () =>
    navigator.clipboard.writeText(code).then(
      () => setCopied("copied"),
      () => setCopied("copy failed"),
    );

  return (
    <figure className="markdown-code">
      <figcaption className="markdown-code__bar">
        <span className="eyebrow">{tag}</span>
        <button
          type="button"
          className="dep-chip"
          aria-label="Copy code"
          onClick={() => void copy()}
        >
          {copied ?? "copy"}
        </button>
      </figcaption>
      <pre>
        <code>
          {spans?.map((span, index) =>
            span.classes ? (
              <span key={index} className={span.classes}>
                {span.text}
              </span>
            ) : (
              span.text
            ),
          ) ?? code}
        </code>
      </pre>
    </figure>
  );
}

const LIST_ITEM = /^\s*([-*]|\d+\.)\s+/;

/** The blocks `source` renders as; the one parse a rendered Markdown pays for. */
export function markdownBlocks(source: string, options: Options): ReactNode[] {
  const lines = source.split("\n");
  const joint = options.breaks ? "\n" : " ";
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (line.startsWith("```")) {
      const tag = line.slice(3).trim().split(/\s/)[0]!;
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      i++;
      blocks.push(<CodeBlock key={key++} code={code.join("\n")} tag={tag} />);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1]!.length;
      const content = inline(heading[2]!, `h${key}`, options);
      blocks.push(
        level === 1 ? (
          <h1 key={key++}>{content}</h1>
        ) : level === 2 ? (
          <h2 key={key++}>{content}</h2>
        ) : level === 3 ? (
          <h3 key={key++}>{content}</h3>
        ) : (
          <h4 key={key++}>{content}</h4>
        ),
      );
      i++;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && LIST_ITEM.test(lines[i]!)) {
        const itemLines = [lines[i]!.replace(LIST_ITEM, "")];
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !LIST_ITEM.test(lines[i]!)) {
          itemLines.push(lines[i]!.trim());
          i++;
        }
        const item = inline(itemLines.join(joint), `li${key}-${items.length}`, options);
        items.push(<li key={items.length}>{item}</li>);
      }
      blocks.push(ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>);
      continue;
    }

    if (line.startsWith("> ")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("> ")) quote.push(lines[i++]!.slice(2));
      const content = inline(quote.join(joint), `q${key}`, options);
      blocks.push(<blockquote key={key++}>{content}</blockquote>);
      continue;
    }

    const paragraph: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !lines[i]!.startsWith("```") &&
      !/^(#{1,4})\s/.test(lines[i]!) &&
      !LIST_ITEM.test(lines[i]!) &&
      !lines[i]!.startsWith("> ")
    ) {
      paragraph.push(lines[i]!);
      i++;
    }
    blocks.push(<p key={key++}>{inline(paragraph.join(joint), `p${key}`, options)}</p>);
  }

  return blocks;
}

/** Parses again only when what it is given changes, so a room drawing a new message or a streamed
 *  delta does not parse the messages it already drew. */
export const Markdown = memo(function Markdown({
  source,
  breaks = false,
  me,
}: {
  source: string;
  breaks?: boolean;
  me?: string;
}) {
  return <div className="markdown">{markdownBlocks(source, { breaks, me })}</div>;
});
