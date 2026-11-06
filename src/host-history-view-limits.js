/**
 * Conservative Host page budgets within the Cindy v1 contract.
 *
 * Stated here rather than imported because this Host composes the protocol over the wire,
 * not the package. The current Cindy v1 view ceiling is 1 MiB, with 20 items and
 * a 256 KiB detail page. This Host deliberately keeps its view budget at 256 KiB;
 * a smaller service budget is compatible and avoids increasing mobile load. These
 * values are Host budgets, not an assertion that all current upstream limits match.
 */

/** Items one `local-db:messages:view` page may carry. */
export const HISTORY_PAGE_ITEMS = 20;

/** Bytes one `local-db:messages:view` page may carry. */
export const HISTORY_PAGE_BYTES = 256 * 1024;

/** Bytes one `local-db:messages:work-details` page may carry. */
export const HISTORY_DETAIL_PAGE_BYTES = 256 * 1024;

/** The protocol version the three view channels answer with. */
export const HISTORY_VIEW_VERSION = 1;
