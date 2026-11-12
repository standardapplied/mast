import { createContext, memo, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { mentionPattern, opensMention } from "./board/mentions";
import { Button } from "./components/ui";
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
  /** Drawn as a room message, as typed: line breaks, blank lines and a link it cannot open stay
   *  as they were written, where a document's lines flow and such a link shows its label. */
  message: boolean;
  /** The reader's handle: a mention of them is marked. */
  me?: string;
};

/** Runs `reset` after `ms`, returning what cancels it. */
export type Schedule = (reset: () => void, ms: number) => () => void;

/** When a code block's Copy says what happened and is Copy again; tests provide their own. */
export const CopyReset = createContext<Schedule>((reset, ms) => {
  const timer = setTimeout(reset, ms);
  return () => clearTimeout(timer);
});

const COPY_FEEDBACK_MS = 1500;
const PARSES_KEPT = 2000;

const PARENTHESIZED = String.raw`\([^\s<>()\[\]]*\)`;
const BARE_URL = String.raw`https?:\/\/(?:[^\s<>()\[\]]|${PARENTHESIZED})*(?:[^\s<>()\[\].,;:!?'"]|${PARENTHESIZED})`;
const FLANKED = String.raw`[^*\s](?:[^*]*[^*\s])?`;
const OPENABLE = /^(?:https?:\/\/|mailto:)/i;
const SCHEMED = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const FENCE_OPEN = /^```\s*([\w+#.-]*)(?:\s.*)?$/;
const FENCE_CLOSE = /^```\s*$/;
const LIST_ITEM = /^\s*([-*]|(\d+)\.)\s+/;

const inlinePatterns = new Map<string, RegExp>();

function inlinePattern(me: string | undefined): RegExp {
  const key = me ?? "";
  let pattern = inlinePatterns.get(key);
  if (!pattern) {
    pattern = new RegExp(
      [
        "(?<fenced>```[^`]+```)",
        "(?<code>`[^`]+`)",
        String.raw`(?<bold>\*\*${FLANKED}\*\*)`,
        String.raw`(?<em>\*${FLANKED}\*)`,
        String.raw`(?<link>\[(?<label>[^\]]+)\]\((?<href>(?:[^()\s]|${PARENTHESIZED})+)\))`,
        `(?<url>${BARE_URL})`,
        ...(me ? [`(?<mention>${mentionPattern(me)})`] : []),
      ].join("|"),
      "g",
    );
    inlinePatterns.set(key, pattern);
  }
  return pattern;
}

function opensFence(line: string): boolean {
  return FENCE_OPEN.test(line) && !line.slice(3).includes("```");
}

function inline(text: string, keyBase: string, options: Options): ReactNode[] {
  const nodes: ReactNode[] = [];
  let i = 0;
  const plain = (value: string) =>
    value.split("\n").forEach((line, index) => {
      if (index > 0) nodes.push(<br key={`${keyBase}-${i++}`} />);
      if (line) nodes.push(line);
    });
  let last = 0;

  for (const match of text.matchAll(inlinePattern(options.me))) {
    const { fenced, code, bold, em, link, label, href, url, mention } = match.groups!;
    const key = `${keyBase}-${i++}`;
    plain(text.slice(last, match.index));
    last = match.index + match[0].length;
    if (fenced) nodes.push(<code key={key}>{fenced.slice(3, -3)}</code>);
    else if (code) nodes.push(<code key={key}>{code.slice(1, -1)}</code>);
    else if (bold) nodes.push(<strong key={key}>{inline(bold.slice(2, -2), key, options)}</strong>);
    else if (em) nodes.push(<em key={key}>{inline(em.slice(1, -1), key, options)}</em>);
    else if (link && OPENABLE.test(href!)) nodes.push(<a key={key} href={href}>{label}</a>);
    else if (link && !options.message && !SCHEMED.test(href!)) plain(label!);
    else if (url) nodes.push(<a key={key} href={url}>{url}</a>);
    else if (mention && opensMention(text, match.index)) {
      nodes.push(<span key={key} className="mention-me">{mention}</span>);
    } else plain(match[0]);
  }
  plain(text.slice(last));
  return nodes;
}

type Copied = "Copied" | "Copy failed";

function CodeBlock({ code, tag }: { code: string; tag: string }) {
  const language = languageForFence(tag);
  const [highlighted, setHighlighted] = useState<{
    code: string;
    language: string;
    spans: HighlightedSpan[] | null;
  } | null>(null);
  const [copied, setCopied] = useState<Copied | null>(null);
  const schedule = useContext(CopyReset);
  const cancelReset = useRef<() => void>(() => {});

  useEffect(() => {
    if (!language) return;
    let current = true;
    highlight(code, language).then(
      (spans) => current && setHighlighted({ code, language, spans }),
      (e: unknown) => logError("highlight", e instanceof Error ? e.message : String(e)),
    );
    return () => {
      current = false;
    };
  }, [code, language]);

  useEffect(() => () => cancelReset.current(), []);

  const tell = (outcome: Copied) => {
    cancelReset.current();
    setCopied(outcome);
    cancelReset.current = schedule(() => setCopied(null), COPY_FEEDBACK_MS);
  };

  const copy = () =>
    navigator.clipboard.writeText(code).then(
      () => tell("Copied"),
      () => tell("Copy failed"),
    );

  const spans =
    highlighted && highlighted.code === code && highlighted.language === language
      ? highlighted.spans
      : null;

  return (
    <figure className="markdown-code">
      <figcaption className="markdown-code__bar">
        {tag && <span className="eyebrow">{tag}</span>}
        <Button variant="ghost" onClick={() => void copy()}>
          {copied ?? "Copy"}
        </Button>
        <span role="status" className="sr-only">
          {copied ?? ""}
        </span>
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

/** The blocks `source` renders as: the parse a rendered Markdown pays for, once per source. */
export function markdownBlocks(source: string, options: Options): ReactNode[] {
  const lines = source.split("\n");
  const joint = options.message ? "\n" : " ";
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      const start = i;
      while (i < lines.length && lines[i]!.trim() === "") i++;
      if (options.message && blocks.length > 0 && i < lines.length) {
        for (let extra = start + 1; extra < i; extra++) blocks.push(<br key={key++} />);
      }
      continue;
    }

    if (opensFence(line)) {
      const tag = FENCE_OPEN.exec(line)![1]!;
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i]!)) code.push(lines[i++]!);
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

    const first = LIST_ITEM.exec(line);
    if (first) {
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
      blocks.push(
        first[2] === undefined ? (
          <ul key={key++}>{items}</ul>
        ) : (
          <ol key={key++} start={Number(first[2])}>
            {items}
          </ol>
        ),
      );
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
      !opensFence(lines[i]!) &&
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

const parses = new Map<string, ReactNode[]>();

/** A source already parsed is drawn from what its parse made, however its row came to remount:
 *  a room that loads earlier messages or acknowledges a send parses no message twice. */
function blocksOf(source: string, options: Options): ReactNode[] {
  const key = `${options.message ? "m" : "d"}|${options.me ?? ""}|${source}`;
  const kept = parses.get(key);
  if (kept) {
    parses.delete(key);
    parses.set(key, kept);
    return kept;
  }
  const blocks = markdownBlocks(source, options);
  parses.set(key, blocks);
  if (parses.size > PARSES_KEPT) parses.delete(parses.keys().next().value!);
  return blocks;
}

export const Markdown = memo(function Markdown({
  source,
  message = false,
  me,
}: {
  source: string;
  message?: boolean;
  me?: string;
}) {
  return <div className="markdown">{blocksOf(source, { message, me })}</div>;
});
