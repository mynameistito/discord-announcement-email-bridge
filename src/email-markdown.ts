const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });

const safeHref = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};

const closingIndex = (source: string, delimiter: string, start: number) => {
  const index = source.indexOf(delimiter, start);
  return index > start ? index : -1;
};

const renderInline = (source: string): string => {
  let output = "";
  let index = 0;

  while (index < source.length) {
    if (source[index] === "`") {
      const end = closingIndex(source, "`", index + 1);
      if (end !== -1) {
        output += `<code>${escapeHtml(source.slice(index + 1, end))}</code>`;
        index = end + 1;
        continue;
      }
    }

    if (source[index] === "[") {
      const labelEnd = source.indexOf("](", index + 1);
      const urlEnd = labelEnd === -1 ? -1 : source.indexOf(")", labelEnd + 2);
      if (labelEnd > index + 1 && urlEnd > labelEnd + 2) {
        const href = safeHref(source.slice(labelEnd + 2, urlEnd));
        if (href) {
          output += `<a href="${escapeHtml(href)}">${renderInline(source.slice(index + 1, labelEnd))}</a>`;
          index = urlEnd + 1;
          continue;
        }
      }
    }

    if (source.startsWith("||", index)) {
      const end = closingIndex(source, "||", index + 2);
      if (end !== -1) {
        output += escapeHtml(source.slice(index, end + 2));
        index = end + 2;
        continue;
      }
    }

    const formatting: ReadonlyArray<readonly [string, string]> = [
      ["**", "strong"],
      ["__", "u"],
      ["~~", "del"],
      ["*", "em"],
      ["_", "em"],
    ];
    const match = formatting.find(([delimiter]) =>
      source.startsWith(delimiter, index)
    );
    if (match) {
      const [delimiter, tag] = match;
      const end = closingIndex(source, delimiter, index + delimiter.length);
      if (end !== -1) {
        output += `<${tag}>${renderInline(source.slice(index + delimiter.length, end))}</${tag}>`;
        index = end + delimiter.length;
        continue;
      }
    }

    output += escapeHtml(source[index] ?? "");
    index += 1;
  }

  return output;
};

const headingLevel = (line: string): number => {
  let count = 0;
  while (line[count] === "#") count += 1;
  return count > 0 && count <= 6 && line[count] === " " ? count : 0;
};

const listType = (line: string): "ul" | "ol" | undefined => {
  if (/^\s*[-*+]\s+/u.test(line)) return "ul";
  if (/^\s*\d+[.)]\s+/u.test(line)) return "ol";
  return undefined;
};

const listContent = (line: string, type: "ul" | "ol"): string =>
  line.replace(type === "ul" ? /^\s*[-*+]\s+/u : /^\s*\d+[.)]\s+/u, "");

/**
 * Render common Discord Markdown as safe HTML for email content.
 *
 * @param markdown - Untrusted Discord message text.
 * @returns Deterministic HTML with raw HTML escaped and only HTTP(S) links enabled.
 */
export function renderEmailMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    if (/^\s*```/u.test(line)) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/u.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const level = headingLevel(line);
    if (level > 0) {
      const content = line.slice(level + 1);
      blocks.push(`<h${level}>${renderInline(content)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*>/u.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/u.test(lines[index] ?? "")) {
        quote.push((lines[index] ?? "").replace(/^\s*> ?/u, ""));
        index += 1;
      }
      blocks.push(
        `<blockquote><p>${renderInline(quote.join(" "))}</p></blockquote>`
      );
      continue;
    }

    const type = listType(line);
    if (type) {
      const items: string[] = [];
      while (index < lines.length && listType(lines[index] ?? "") === type) {
        items.push(
          `<li>${renderInline(listContent(lines[index] ?? "", type))}</li>`
        );
        index += 1;
      }
      blocks.push(`<${type}>${items.join("")}</${type}>`);
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() !== "" &&
      headingLevel(lines[index] ?? "") === 0 &&
      listType(lines[index] ?? "") === undefined &&
      !/^\s*[>`]/u.test(lines[index] ?? "") &&
      !/^\s*```/u.test(lines[index] ?? "")
    ) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push(`<p>${renderInline(paragraph.join("\n"))}</p>`);
  }

  return blocks.join("\n");
}
