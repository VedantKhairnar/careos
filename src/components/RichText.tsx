import type { ReactNode } from "react";

/**
 * Renders the small amount of formatting an assistant may use (bold and short bullet lists) as real elements, so a
 * patient never sees raw asterisks. React text nodes only: nothing here can inject HTML.
 */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*\n]+\*\*)/g).map((part, i) => (part.length > 4 && part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : part));
}

export function RichText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) {
      const items = bullets;
      blocks.push(
        <ul key={`ul${blocks.length}`} className="my-1 list-disc space-y-1 pl-5">
          {items.map((b, i) => (
            <li key={i}>{inline(b)}</li>
          ))}
        </ul>,
      );
      bullets = [];
    }
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const bullet = /^[*-]\s+(.*)$/.exec(line);
    if (bullet) bullets.push(bullet[1]);
    else {
      flush();
      if (line) blocks.push(<p key={`p${blocks.length}`}>{inline(line)}</p>);
    }
  }
  flush();
  return <div className="space-y-2">{blocks}</div>;
}
