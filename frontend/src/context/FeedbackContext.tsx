import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { FeedbackModal } from '../components/FeedbackModal';
import { api } from '../api/client';
import {
  formatErrorFeedbackMessage,
  getTechnicalDetail,
  getUserErrorMessage,
  isReportableError,
} from '../utils/errors';
import { getPageLabel } from '../utils/pages';

type OpenFeedbackOptions = {
  /** Prefills the message textarea (e.g. transaction details). */
  initialMessage?: string;
};

type ReportErrorOptions = {
  /** Optional override for the friendly message shown/reported. */
  userMessage?: string;
  /** When false, skip emailing (e.g. feedback modal failures). Default: auto. */
  reportable?: boolean;
};

type FeedbackContextValue = {
  openFeedback: (options?: OpenFeedbackOptions) => void;
  /** Emails an automatic error report (deduped) with page + description. */
  reportError: (error: unknown, options?: ReportErrorOptions) => void;
};

const FeedbackContext = createContext<FeedbackContextValue | null>(null);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [initialMessage, setInitialMessage] = useState<string | undefined>();
  const reportedKeys = useRef(new Set<string>());

  const openFeedback = useCallback((options?: OpenFeedbackOptions) => {
    setInitialMessage(options?.initialMessage);
    setOpen(true);
  }, []);

  const closeFeedback = useCallback(() => {
    setOpen(false);
    setInitialMessage(undefined);
  }, []);

  const reportError = useCallback((error: unknown, options?: ReportErrorOptions) => {
    const reportable = options?.reportable ?? isReportableError(error);
    if (!reportable) return;

    const pageLabel = getPageLabel();
    const pageUrl = window.location.href;
    const userMessage = options?.userMessage ?? getUserErrorMessage(error);
    const technicalDetail = getTechnicalDetail(error);
    const key = `${pageLabel}|${userMessage}|${technicalDetail}`;
    if (reportedKeys.current.has(key)) return;
    reportedKeys.current.add(key);

    const message = formatErrorFeedbackMessage({
      pageLabel,
      userMessage,
      technicalDetail,
      pageUrl,
    });

    void api
      .submitFeedback({
        message,
        name: 'SimplifAI automatic error report',
        page_url: pageUrl,
      })
      .catch(() => {
        // Never surface or re-report feedback delivery failures.
      });
  }, []);

  const value = useMemo(
    () => ({ openFeedback, reportError }),
    [openFeedback, reportError],
  );

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <FeedbackModal
        open={open}
        onClose={closeFeedback}
        initialMessage={initialMessage}
      />
    </FeedbackContext.Provider>
  );
}

export function useFeedback() {
  const ctx = useContext(FeedbackContext);
  if (!ctx) {
    throw new Error('useFeedback must be used within FeedbackProvider');
  }
  return ctx;
}
