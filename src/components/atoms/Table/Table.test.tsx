import { describe, expect, test } from "bun:test";
import { createRef } from "react";
import { render, screen, within } from "@testing-library/react";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "./Table";
import type { TableProps } from "./Table";
import { expectFocused } from "@/test/dom-assertions";

function Specs(props: Partial<TableProps>) {
  return (
    <Table label="Specifications" {...props}>
      <TableCaption>Technical details</TableCaption>
      <TableHead>
        <TableRow>
          <TableHeaderCell>Feature</TableHeaderCell>
          <TableHeaderCell numeric sort="asc">
            Price
          </TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        <TableRow>
          <TableHeaderCell scope="row">Weight</TableHeaderCell>
          <TableCell numeric>$1.00</TableCell>
        </TableRow>
        <TableRow>
          <TableHeaderCell scope="row">Colour</TableHeaderCell>
          <TableCell>Blue</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

describe("Table", () => {
  test("renders a table inside a focusable, labelled scroll region", () => {
    render(<Specs />);
    const region = screen.getByRole("region", { name: "Specifications" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toHaveClass("overflow-x-auto");
    const table = within(region).getByRole("table", { name: "Technical details" });
    expect(table.tagName).toBe("TABLE");
  });

  test("region is reachable by keyboard focus", () => {
    render(<Specs />);
    const region = screen.getByRole("region", { name: "Specifications" });
    region.focus();
    expectFocused(region);
  });

  test("header cells default to scope=col and accept scope=row", () => {
    render(<Specs />);
    expect(screen.getByRole("columnheader", { name: "Feature" })).toHaveAttribute("scope", "col");
    expect(screen.getByRole("rowheader", { name: "Weight" })).toHaveAttribute("scope", "row");
  });

  test("sort maps to aria-sort with a decorative indicator", () => {
    const { rerender } = render(<Specs />);
    const price = screen.getByRole("columnheader", { name: /Price/ });
    expect(price).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getByTestId("sort-indicator")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("columnheader", { name: "Feature" })).not.toHaveAttribute("aria-sort");

    rerender(
      <Table label="t">
        <TableHead>
          <TableRow>
            <TableHeaderCell sort="desc">A</TableHeaderCell>
            <TableHeaderCell sort="none">B</TableHeaderCell>
          </TableRow>
        </TableHead>
      </Table>,
    );
    expect(screen.getByRole("columnheader", { name: /A/ })).toHaveAttribute("aria-sort", "descending");
    const b = screen.getByRole("columnheader", { name: "B" });
    expect(b).toHaveAttribute("aria-sort", "none");
    expect(within(b).queryByTestId("sort-indicator")).toBeNull();
  });

  test("numeric cells align end with tabular figures; align overrides", () => {
    render(
      <Table label="t">
        <TableBody>
          <TableRow>
            <TableCell numeric>3</TableCell>
            <TableCell align="center">c</TableCell>
            <TableCell>s</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole("cell", { name: "3" })).toHaveClass("text-end", "tabular-nums");
    expect(screen.getByRole("cell", { name: "c" })).toHaveClass("text-center");
    expect(screen.getByRole("cell", { name: "s" })).toHaveClass("text-start");
  });

  test("density compact sets data-compact and smaller type", () => {
    const { rerender } = render(<Specs />);
    const table = screen.getByRole("table");
    expect(table).not.toHaveAttribute("data-compact");
    expect(table).toHaveClass("text-body", "group/table");
    rerender(<Specs density="compact" />);
    expect(screen.getByRole("table")).toHaveAttribute("data-compact", "");
    expect(screen.getByRole("table")).toHaveClass("text-small");
    expect(screen.getByRole("cell", { name: "Blue" })).toHaveClass("group-data-compact/table:py-1");
  });

  test("striped sets data-striped; rows carry the sunken stripe variant", () => {
    render(<Specs striped />);
    expect(screen.getByRole("table")).toHaveAttribute("data-striped", "");
    const rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveClass("group-data-striped/table:even:bg-surface-sunken");
  });

  test("caption can sit at the bottom or be visually hidden", () => {
    const { rerender } = render(
      <Table label="t">
        <TableCaption side="bottom">Cap</TableCaption>
      </Table>,
    );
    expect(screen.getByText("Cap")).toHaveClass("caption-bottom");
    rerender(
      <Table label="t">
        <TableCaption visuallyHidden>Cap</TableCaption>
      </Table>,
    );
    expect(screen.getByText("Cap")).toHaveClass("sr-only");
  });

  test("forwards ref to <table>; className on table, wrapperClassName on region", () => {
    const ref = createRef<HTMLTableElement>();
    render(
      <Table label="t" ref={ref} className="min-w-96" wrapperClassName="mt-2">
        <TableBody />
      </Table>,
    );
    expect(ref.current?.tagName).toBe("TABLE");
    expect(ref.current?.className.endsWith("min-w-96")).toBe(true);
    expect(screen.getByRole("region").className.endsWith("mt-2")).toBe(true);
  });

  test("sub-components merge className last", () => {
    render(
      <Table label="t">
        <TableHead className="x-head">
          <TableRow className="x-row">
            <TableHeaderCell className="x-th">H</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody className="x-body">
          <TableRow>
            <TableCell className="x-td">D</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole("columnheader").className.endsWith("x-th")).toBe(true);
    expect(screen.getByRole("cell").className.endsWith("x-td")).toBe(true);
    expect(screen.getAllByRole("row")[0]?.className.endsWith("x-row")).toBe(true);
  });
});
