import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { FeedbackModal } from '../components/FeedbackModal';

type OpenFeedbackOptions = {
  /** Prefills the message textarea (e.g. transaction details). */
  initialMessage?: string;
};

type FeedbackContextValue = {
  openFeedback: (options?: OpenFeedbackOptions) => void;
};

const FeedbackContext = createContext<FeedbackContextValue | null>(null);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [initialMessage, setInitialMessage] = useState<string | undefined>();

  const openFeedback = useCallback((options?: OpenFeedbackOptions) => {
    setInitialMessage(options?.initialMessage);
    setOpen(true);
  }, []);

  const closeFeedback = useCallback(() => {
    setOpen(false);
    setInitialMessage(undefined);
  }, []);

  const value = useMemo(() => ({ openFeedback }), [openFeedback]);

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
