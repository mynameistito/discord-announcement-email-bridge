const escapeHtml = (value: string): string =>
  value.replaceAll(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&": {
        return "&amp;";
      }
      case "<": {
        return "&lt;";
      }
      case ">": {
        return "&gt;";
      }
      case '"': {
        return "&quot;";
      }
      case "'": {
        return "&#39;";
      }
      default: {
        return character;
      }
    }
  });

/**
 * Escape untrusted text for insertion into email HTML.
 * @param value - Untrusted text.
 * @returns HTML-escaped text.
 */
export const escapeEmailHtml = (value: string): string => escapeHtml(value);

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

interface InlineToken {
  readonly html: string;
  readonly next: number;
}

const inlineCode = (source: string, index: number): InlineToken | undefined => {
  if (source[index] !== "`") {
    return undefined;
  }
  const end = closingIndex(source, "`", index + 1);
  return end < 0
    ? undefined
    : {
        html: `<code>${escapeHtml(source.slice(index + 1, end))}</code>`,
        next: end + 1,
      };
};

const inlineLink = (
  source: string,
  index: number,
  renderNested: (source: string) => string
): InlineToken | undefined => {
  if (source[index] !== "[") {
    return undefined;
  }
  const labelEnd = source.indexOf("](", index + 1);
  const urlEnd = labelEnd === -1 ? -1 : source.indexOf(")", labelEnd + 2);
  if (labelEnd <= index + 1 || urlEnd <= labelEnd + 2) {
    return undefined;
  }
  const href = safeHref(source.slice(labelEnd + 2, urlEnd));
  return href
    ? {
        html: `<a href="${escapeHtml(href)}">${renderNested(source.slice(index + 1, labelEnd))}</a>`,
        next: urlEnd + 1,
      }
    : undefined;
};

const inlineSpoiler = (
  source: string,
  index: number
): InlineToken | undefined => {
  if (!source.startsWith("||", index)) {
    return undefined;
  }
  const end = closingIndex(source, "||", index + 2);
  return end < 0
    ? undefined
    : { html: escapeHtml(source.slice(index, end + 2)), next: end + 2 };
};

const formatting: readonly (readonly [string, string])[] = [
  ["**", "strong"],
  ["__", "u"],
  ["~~", "del"],
  ["*", "em"],
  ["_", "em"],
];

const inlineFormatting = (
  source: string,
  index: number,
  renderNested: (source: string) => string
): InlineToken | undefined => {
  for (const [delimiter, tag] of formatting) {
    if (!source.startsWith(delimiter, index)) {
      continue;
    }
    const end = closingIndex(source, delimiter, index + delimiter.length);
    if (end >= 0) {
      return {
        html: `<${tag}>${renderNested(source.slice(index + delimiter.length, end))}</${tag}>`,
        next: end + delimiter.length,
      };
    }
  }
  return undefined;
};

/**
 * Render inline Discord Markdown with raw HTML escaped and safe links only.
 * @param source - Untrusted inline Markdown.
 * @returns Email-safe inline HTML.
 */
export const renderInline = (source: string): string => {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const token =
      inlineCode(source, index) ??
      inlineLink(source, index, renderInline) ??
      inlineSpoiler(source, index) ??
      inlineFormatting(source, index, renderInline);
    if (token) {
      output += token.html;
      index = token.next;
    } else {
      const character = source[index] ?? "";
      output += character === "\n" ? "<br />" : escapeHtml(character);
      index += 1;
    }
  }
  return output;
};
