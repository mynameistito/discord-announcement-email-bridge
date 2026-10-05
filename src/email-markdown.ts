import { escapeEmailHtml, renderInline } from "@/email-markdown-inline";

const headingLevel = (line: string): number => {
  let count = 0;
  while (line[count] === "#") {
    count += 1;
  }
  return count > 0 && count <= 6 && line[count] === " " ? count : 0;
};

const listType = (line: string): "ul" | "ol" | undefined => {
  if (/^\s*[-*+]\s+/u.test(line)) {
    return "ul";
  }
  if (/^\s*\d+[.)]\s+/u.test(line)) {
    return "ol";
  }
  return undefined;
};

const listContent = (line: string, type: "ul" | "ol"): string =>
  line.replace(type === "ul" ? /^\s*[-*+]\s+/u : /^\s*\d+[.)]\s+/u, "");

interface RenderedBlock {
  readonly html: string;
  readonly next: number;
}

const renderCodeBlock = (
  lines: readonly string[],
  index: number
): RenderedBlock | undefined => {
  const fence = parseFence(lines[index] ?? "");
  if (!fence) {
    return undefined;
  }
  const code: string[] = [];
  let next = index + 1;
  while (
    next < lines.length &&
    !isClosingFence(lines[next] ?? "", fence.character, fence.length)
  ) {
    code.push(lines[next] ?? "");
    next += 1;
  }
  if (next < lines.length) {
    next += 1;
  }
  return {
    html: `<pre><code>${escapeEmailHtml(code.join("\n"))}</code></pre>`,
    next,
  };
};

const parseFence = (
  line: string
): { readonly character: string; readonly length: number } | undefined => {
  const candidate = line.trimStart();
  const character = candidate[0];
  if (character !== "`" && character !== "~") {
    return undefined;
  }
  let length = 0;
  while (candidate[length] === character) {
    length += 1;
  }
  return length >= 3 ? { character, length } : undefined;
};

const isClosingFence = (
  line: string,
  character: string,
  minimumLength: number
): boolean => {
  const candidate = line.trimStart();
  let length = 0;
  while (candidate[length] === character) {
    length += 1;
  }
  return length >= minimumLength && candidate.slice(length).trim() === "";
};

const renderHeading = (
  line: string,
  index: number
): RenderedBlock | undefined => {
  const level = headingLevel(line);
  if (level === 0) {
    return undefined;
  }
  const content = renderInline(line.slice(level + 1));
  return { html: `<h${level}>${content}</h${level}>`, next: index + 1 };
};

const renderQuote = (
  lines: readonly string[],
  index: number
): RenderedBlock | undefined => {
  if (!/^\s*>/u.test(lines[index] ?? "")) {
    return undefined;
  }
  const quote: string[] = [];
  let next = index;
  while (next < lines.length && /^\s*>/u.test(lines[next] ?? "")) {
    quote.push((lines[next] ?? "").replace(/^\s*> ?/u, ""));
    next += 1;
  }
  return {
    html: `<blockquote><p>${renderInline(quote.join("\n"))}</p></blockquote>`,
    next,
  };
};

const renderList = (
  lines: readonly string[],
  index: number
): RenderedBlock | undefined => {
  const type = listType(lines[index] ?? "");
  if (!type) {
    return undefined;
  }
  const items: string[] = [];
  let next = index;
  while (next < lines.length && listType(lines[next] ?? "") === type) {
    items.push(
      `<li>${renderInline(listContent(lines[next] ?? "", type))}</li>`
    );
    next += 1;
  }
  return { html: `<${type}>${items.join("")}</${type}>`, next };
};

const isParagraphContinuation = (line: string): boolean => {
  if (line.trim() === "" || headingLevel(line) > 0) {
    return false;
  }
  if (listType(line) !== undefined || /^\s*[>`]/u.test(line)) {
    return false;
  }
  return !/^\s*(?:`{3,}|~{3,})/u.test(line);
};

const renderParagraph = (
  lines: readonly string[],
  index: number
): RenderedBlock => {
  const paragraph = [lines[index] ?? ""];
  let next = index + 1;
  while (next < lines.length && isParagraphContinuation(lines[next] ?? "")) {
    paragraph.push(lines[next] ?? "");
    next += 1;
  }
  return { html: `<p>${renderInline(paragraph.join("\n"))}</p>`, next };
};

const renderBlock = (
  lines: readonly string[],
  index: number
): RenderedBlock => {
  const line = lines[index] ?? "";
  return (
    renderCodeBlock(lines, index) ??
    renderHeading(line, index) ??
    renderQuote(lines, index) ??
    renderList(lines, index) ??
    renderParagraph(lines, index)
  );
};

/**
 * Render common Discord Markdown as safe HTML for email content.
 * @param markdown - Untrusted Discord message text.
 * @returns Deterministic HTML with raw HTML escaped and only HTTP(S) links enabled.
 */
export const renderEmailMarkdown = (markdown: string): string => {
  const lines = markdown.replaceAll(/\r\n?/gu, "\n").split("\n");
  const blocks: string[] = [];
  let index = 0;
  while (index < lines.length) {
    if ((lines[index] ?? "").trim() === "") {
      index += 1;
      continue;
    }
    const block = renderBlock(lines, index);
    blocks.push(block.html);
    index = block.next;
  }
  return blocks.join("\n");
};
