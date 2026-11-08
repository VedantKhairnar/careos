import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RichText } from "@/components/RichText";

describe("RichText", () => {
  it("turns bold and bullet lines into real elements, with no leftover asterisks", () => {
    const html = renderToStaticMarkup(<RichText text={"You take:\n\n* **Med A**: 1 tablet\n- **Med B**: 2 tablets\nThat is all."} />);
    expect(html).toContain("<strong>Med A</strong>");
    expect(html).toContain("<ul");
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).not.toContain("*");
  });
  it("cannot inject markup", () => {
    const html = renderToStaticMarkup(<RichText text={"<img src=x onerror=alert(1)> **bold**"} />);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
