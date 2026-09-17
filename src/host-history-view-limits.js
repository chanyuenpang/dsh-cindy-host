/**
 * The history view's page budgets, mirrored from the Cindy contract.
 *
 * Stated here rather than imported because this Host composes the protocol over the wire,
 * not the package: `@cindy/maker-shared/message-window` publishes
 * `HISTORY_VIEW_PAGE_ITEMS = 20`, `HISTORY_VIEW_PAGE_BYTES = 256 * 1024`,
 * `HISTORY_DETAIL_PAGE_BYTES = 256 * 1024`, and `HISTORY_VIEW_VERSION = 1`. A change on
 * the Cindy side shows up as a failing test here instead of a page the phone silently
 * truncates.
 */

/** Items one `local-db:messages:view` page may carry. */
export const HISTORY_PAGE_ITEMS = 20;

/** Bytes one `local-db:messages:view` page may carry. */
export const HISTORY_PAGE_BYTES = 256 * 1024;

/** Bytes one `local-db:messages:work-details` page may carry. */
export const HISTORY_DETAIL_PAGE_BYTES = 256 * 1024;

/** The protocol version the three view channels answer with. */
export const HISTORY_VIEW_VERSION = 1;
