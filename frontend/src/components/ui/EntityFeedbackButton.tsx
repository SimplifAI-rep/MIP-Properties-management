import { useFeedback } from '../../context/FeedbackContext';
import { Tooltip } from './Tooltip';

const feedbackIcon = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 20 20"
    fill="currentColor"
    className="h-4 w-4"
    aria-hidden="true"
  >
    <path
      fillRule="evenodd"
      d="M10 2c-2.236 0-4.43.18-6.512.512C2.35 2.718 1.5 3.958 1.5 5.373v4.254c0 1.415.85 2.655 1.988 2.86 1.113.178 2.259.3 3.418.364V16.5a.75.75 0 0 0 1.28.53l2.754-2.753A32.978 32.978 0 0 0 10 14c2.236 0 4.43-.18 6.512-.512 1.138-.205 1.988-1.445 1.988-2.86V5.373c0-1.415-.85-2.655-1.988-2.86A33.001 33.001 0 0 0 10 2Zm0 5a1 1 0 1 0 0 2 1 1 0 0 0 0-2ZM7 8a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm6 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"
      clipRule="evenodd"
    />
  </svg>
);

type EntityFeedbackButtonProps = {
  message: string;
  ariaLabel?: string;
};

/** Opens the shared feedback modal with a prefilled entity message. */
export function EntityFeedbackButton({
  message,
  ariaLabel = 'Send feedback',
}: EntityFeedbackButtonProps) {
  const { openFeedback } = useFeedback();
  return (
    <Tooltip content="Feedback" hideHint>
      <button
        type="button"
        className="btn-icon"
        onClick={() => openFeedback({ initialMessage: message })}
        aria-label={ariaLabel}
      >
        {feedbackIcon}
      </button>
    </Tooltip>
  );
}
