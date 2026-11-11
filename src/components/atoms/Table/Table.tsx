import type { ComponentPropsWithRef } from "react";

export type TableDensity = "compact" | "regular";
export type TableSort = "asc" | "desc" | "none";
export type TableCellAlign = "start" | "center" | "end";

export interface TableProps extends ComponentPropsWithRef<"table"> {
  /**
   * Accessible name of the scrollable region wrapper (`role="region"`). Required
   * so keyboard and screen-reader users can find and scroll the table.
   */
  label: string;
  /** Cell padding and type size. Defaults to "regular". */
  density?: TableDensity;
  /** Zebra-stripe body rows with `bg-surface-sunken`. */
  striped?: boolean;
  /** Classes for the scroll wrapper (`className` goes on the `<table>`). */
  wrapperClassName?: string;
}

/**
 * Data table. Composable: `Table > TableCaption? + TableHead + TableBody`, rows
 * of `TableHeaderCell` / `TableCell`. Server-component safe (no context):
 * density and striping reach the cells through the `group/table` data
 * attributes. The wrapper is a focusable, labelled region with
 * `overflow-x-auto` so narrow screens can scroll it with the keyboard.
 */
export function Table({
  label,
  density = "regular",
  striped = false,
  wrapperClassName,
  className,
  ref,
  children,
  ...rest
}: TableProps) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={["w-full overflow-x-auto", wrapperClassName].filter(Boolean).join(" ")}
    >
      <table
        {...rest}
        ref={ref}
        data-compact={density === "compact" ? "" : undefined}
        data-striped={striped ? "" : undefined}
        className={[
          "group/table w-full border-collapse text-start text-text-primary",
          density === "compact" ? "text-small" : "text-body",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {children}
      </table>
    </div>
  );
}

export interface TableCaptionProps extends ComponentPropsWithRef<"caption"> {
  /** Caption placement. Defaults to "top". */
  side?: "top" | "bottom";
  /** Keep the caption for assistive tech only. */
  visuallyHidden?: boolean;
}

export function TableCaption({
  side = "top",
  visuallyHidden = false,
  className,
  ref,
  ...rest
}: TableCaptionProps) {
  const classes = visuallyHidden
    ? ["sr-only", className]
    : [
        "py-2 text-start text-small text-text-secondary",
        side === "bottom" ? "caption-bottom" : "caption-top",
        className,
      ];
  return <caption {...rest} ref={ref} className={classes.filter(Boolean).join(" ")} />;
}

export type TableHeadProps = ComponentPropsWithRef<"thead">;

export function TableHead({ className, ref, ...rest }: TableHeadProps) {
  return (
    <thead
      {...rest}
      ref={ref}
      className={["border-b-2 border-border-strong", className].filter(Boolean).join(" ")}
    />
  );
}

export type TableBodyProps = ComponentPropsWithRef<"tbody">;

export function TableBody({ className, ref, ...rest }: TableBodyProps) {
  return <tbody {...rest} ref={ref} className={className} />;
}

export type TableRowProps = ComponentPropsWithRef<"tr">;

export function TableRow({ className, ref, ...rest }: TableRowProps) {
  return (
    <tr
      {...rest}
      ref={ref}
      className={[
        "border-b border-border-default group-data-striped/table:even:bg-surface-sunken",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
}

const alignClasses: Record<TableCellAlign, string> = {
  start: "text-start",
  center: "text-center",
  end: "text-end",
};

const cellPadding = "px-3 py-3 group-data-compact/table:px-2 group-data-compact/table:py-1";

export interface TableHeaderCellProps extends Omit<ComponentPropsWithRef<"th">, "align"> {
  /** Defaults to "col". Use "row" for the first cell of a body row. */
  scope?: "col" | "row" | "colgroup" | "rowgroup";
  /**
   * Current sort of this column. Sets `aria-sort` and a decorative arrow.
   * Omit for unsortable columns. Put the sort control (a `<button>` or link)
   * inside the cell as children.
   */
  sort?: TableSort;
  align?: TableCellAlign;
  /** Right-aligns with tabular figures (prices, quantities). */
  numeric?: boolean;
}

const ariaSort = {
  asc: "ascending",
  desc: "descending",
  none: "none",
} as const;

export function TableHeaderCell({
  scope = "col",
  sort,
  align,
  numeric = false,
  className,
  ref,
  children,
  ...rest
}: TableHeaderCellProps) {
  const resolvedAlign = align ?? (numeric ? "end" : "start");
  return (
    <th
      {...rest}
      ref={ref}
      scope={scope}
      aria-sort={sort ? ariaSort[sort] : undefined}
      className={[
        cellPadding,
        "align-bottom font-semibold",
        alignClasses[resolvedAlign],
        numeric ? "tabular-nums" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
      {sort === "asc" || sort === "desc" ? (
        <span aria-hidden="true" data-testid="sort-indicator" className="ms-1 text-text-secondary">
          {sort === "asc" ? "↑" : "↓"}
        </span>
      ) : null}
    </th>
  );
}

export interface TableCellProps extends Omit<ComponentPropsWithRef<"td">, "align"> {
  align?: TableCellAlign;
  /** Right-aligns with tabular figures (prices, quantities). */
  numeric?: boolean;
}

export function TableCell({ align, numeric = false, className, ref, ...rest }: TableCellProps) {
  const resolvedAlign = align ?? (numeric ? "end" : "start");
  return (
    <td
      {...rest}
      ref={ref}
      className={[
        cellPadding,
        "align-top",
        alignClasses[resolvedAlign],
        numeric ? "tabular-nums" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
}
