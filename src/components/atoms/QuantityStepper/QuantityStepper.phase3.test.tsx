import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QuantityStepper } from "./QuantityStepper";

describe("QuantityStepper phase 3", () => {
  test("pill outline: rounded-full group, end buttons rounded on their outer side", () => {
    const html = renderToStaticMarkup(<QuantityStepper id="qty" value={1} max={5} onChange={() => {}} />);
    expect(html).toContain("items-stretch rounded-full border border-border-strong");
    expect(html).toContain("rounded-l-full");
    expect(html).toContain("rounded-r-full");
    expect(html).not.toContain("rounded-l-md");
  });
});
