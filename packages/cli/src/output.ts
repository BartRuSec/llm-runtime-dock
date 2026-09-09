/**
 * Aligned plain-text layout (spec §27).
 *
 * `models`, `runtimes`, `doctor` and `probe` each grew their own `padEnd`
 * arithmetic. They share it here for one reason beyond duplication: every one
 * of those widths came from `String.length`, which counts ANSI escape bytes, so
 * a coloured cell would have blown the column apart. These helpers pad the raw
 * text and apply the style afterwards, which is the only order that works.
 *
 * No box drawing and no table library: aligned columns stay greppable and paste
 * into an issue unchanged, and a `string-width` dependency would reach the
 * published bundle for nothing.
 */

export type Style = (text: string) => string;

/** Two spaces, wide enough to read as a column break without a separator. */
const GAP = '  ';

/**
 * A header row plus one line per row, every column padded to its widest cell.
 *
 * `styles[i]` is applied to column `i` after padding, so it may emit colour.
 * The last column is never padded — trailing whitespace serves nobody.
 */
export const columns = (
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  styles: readonly (Style | undefined)[] = [],
  headerStyle?: Style,
): string[] => {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  );

  // `trimEnd` runs on the rendered line, so an empty *last* cell would strip
  // padding that a styled line keeps inside its escape sequences — stripping
  // the colour back off would then not reproduce the plain line. Callers pass
  // a non-empty last cell; `runtimes` already uses `-` as its placeholder.
  const render = (
    cells: readonly string[],
    style: (index: number) => Style | undefined,
  ): string => {
    const last = cells.length - 1;
    return cells
      .map((cell, index) => {
        const padded = index === last ? cell : cell.padEnd(widths[index] ?? 0);
        return style(index)?.(padded) ?? padded;
      })
      .join(GAP)
      .trimEnd();
  };

  return [
    render(headers, () => headerStyle),
    ...rows.map((row) => render(row, (index) => styles[index])),
  ];
};

/**
 * `Label:   value` — the shape `status` and `runtimes` already print. The label
 * is padded before styling, for the same reason `columns` pads before styling.
 */
export const keyValue = (
  label: string,
  value: string,
  width: number,
  styles: { readonly label?: Style; readonly value?: Style } = {},
): string => {
  // `width + 2` is the colon plus one space, so the longest label leaves a
  // single gap and every value in the block starts in the same column — the
  // layout §27 documents line for line.
  const padded = `${label}:`.padEnd(width + 2);
  return `${styles.label?.(padded) ?? padded}${styles.value?.(value) ?? value}`;
};

/** The widest of a set of labels, so a block of `keyValue` lines lines up. */
export const labelWidth = (labels: readonly string[]): number =>
  Math.max(0, ...labels.map((label) => label.length));
