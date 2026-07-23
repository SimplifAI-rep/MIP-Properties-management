/**
 * User-facing errors. Prefer AppError from the API client, or plain Error for
 * validation copy that should not be emailed as an automatic report.
 */

export class AppError extends Error {
  /** Plain-language message safe to show in the UI. */
  readonly userMessage: string;
  /** Raw/technical detail for support email (never shown as primary UI copy). */
  readonly technicalDetail: string;
  /** When true, the UI should email a feedback report. */
  readonly reportable: boolean;
  readonly status?: number;

  constructor(options: {
    userMessage: string;
    technicalDetail?: string;
    reportable?: boolean;
    status?: number;
  }) {
    super(options.userMessage);
    this.name = 'AppError';
    this.userMessage = options.userMessage;
    this.technicalDetail = options.technicalDetail ?? options.userMessage;
    this.reportable = options.reportable ?? true;
    this.status = options.status;
  }
}

/** Client-side validation / guidance — shown to the user, not emailed. */
export function validationError(message: string): AppError {
  return new AppError({
    userMessage: message,
    technicalDetail: message,
    reportable: false,
  });
}

function friendlyForStatus(status: number): string {
  if (status === 0 || status === 408) {
    return 'We could not reach the server. Check your internet connection and try again.';
  }
  if (status === 400 || status === 422) {
    return 'Some of the information entered could not be saved. Please check your entries and try again.';
  }
  if (status === 401 || status === 403) {
    return 'You do not have permission to do that.';
  }
  if (status === 404) {
    return 'We could not find what you asked for. It may have been removed.';
  }
  if (status === 409) {
    return 'This action conflicts with existing data. Refresh the page and try again.';
  }
  if (status === 413) {
    return 'The file is too large to upload. Try a smaller file.';
  }
  if (status >= 500) {
    return 'Something went wrong on our side. Please try again in a moment.';
  }
  return 'Something went wrong. Please try again.';
}

function extractDetail(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      const detail = (parsed as { detail?: unknown }).detail;
      if (typeof detail === 'string') return detail;
      if (Array.isArray(detail)) {
        return detail
          .map((item) => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object' && 'msg' in item) {
              return String((item as { msg: unknown }).msg);
            }
            return JSON.stringify(item);
          })
          .join('; ');
      }
      if (detail != null) return JSON.stringify(detail);
      if ('message' in (parsed as object)) {
        return String((parsed as { message: unknown }).message);
      }
    }
  } catch {
    // plain text body
  }
  return trimmed;
}

/** True when the detail looks like something a non-technical user can read. */
function looksUserFriendly(detail: string): boolean {
  if (!detail || detail.length > 280) return false;
  if (/^\s*[{[]/.test(detail)) return false;
  if (/traceback|exception|sqlalchemy|psycopg|sqlite3|uvicorn|fastapi/i.test(detail)) {
    return false;
  }
  if (/at .+\.(py|ts|tsx|js):\d+/i.test(detail)) return false;
  return true;
}

export function appErrorFromResponse(status: number, bodyText: string): AppError {
  const detail = extractDetail(bodyText);
  const technicalDetail = detail || `HTTP ${status}`;
  // Prefer short, clear API messages (e.g. validation) over generic status text.
  const userMessage =
    looksUserFriendly(detail) && (status < 500 || status === 503)
      ? detail
      : friendlyForStatus(status);

  return new AppError({
    userMessage,
    technicalDetail,
    reportable: true,
    status,
  });
}

export function getUserErrorMessage(
  error: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (error instanceof AppError) return error.userMessage;
  if (error instanceof Error && error.message.trim()) {
    const detail = extractDetail(error.message);
    if (looksUserFriendly(detail)) return detail;
    if (looksUserFriendly(error.message)) return error.message;
  }
  if (typeof error === 'string' && looksUserFriendly(error)) return error;
  return fallback;
}

export function getTechnicalDetail(error: unknown): string {
  if (error instanceof AppError) return error.technicalDetail;
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function isReportableError(error: unknown): boolean {
  if (error instanceof AppError) return error.reportable;
  // Unknown thrown values from the network layer are reportable by default.
  if (error instanceof Error) {
    // Already-friendly validation strings thrown as plain Error stay local.
    return !looksUserFriendly(error.message) || /failed|error|unable|could not/i.test(error.message);
  }
  return true;
}

export function formatErrorFeedbackMessage(options: {
  pageLabel: string;
  userMessage: string;
  technicalDetail?: string;
  pageUrl?: string;
}): string {
  const lines = [
    'Automatic error report from SimplifAI',
    '',
    `Page: ${options.pageLabel}`,
    `What the user saw: ${options.userMessage}`,
  ];
  if (options.pageUrl) {
    lines.push(`URL: ${options.pageUrl}`);
  }
  if (options.technicalDetail && options.technicalDetail !== options.userMessage) {
    lines.push('', 'Technical details:', options.technicalDetail);
  }
  return lines.join('\n');
}
