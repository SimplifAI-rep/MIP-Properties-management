import { useEffect, useId, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../api/client';

type FeedbackModalProps = {
  open: boolean;
  onClose: () => void;
  /** Prefills the message when the modal opens. */
  initialMessage?: string;
};

export function FeedbackModal({ open, onClose, initialMessage }: FeedbackModalProps) {
  const titleId = useId();
  const [message, setMessage] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  const mutation = useMutation({
    mutationFn: api.submitFeedback,
    onSuccess: () => {
      setSent(true);
      setMessage('');
    },
  });

  useEffect(() => {
    if (open) {
      setSent(false);
      setMessage(initialMessage ?? '');
      setName('');
      setEmail('');
      mutation.reset();
    }
    // Only reset when the modal opens (or prefill changes while opening)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- avoid resetting mid-edit on mutation identity
  }, [open, initialMessage]);

  if (!open) return null;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!message.trim()) return;
    mutation.mutate({
      message: message.trim(),
      name: name.trim() || undefined,
      email: email.trim() || undefined,
      page_url: window.location.href,
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onClose}
    >
      <div
        className="panel flex w-full max-w-md flex-col gap-4 p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 id={titleId} className="detail-title">
              Send feedback
            </h3>
            <p className="page-desc mt-1">
              {initialMessage
                ? 'Transaction details are included below. Add your note and send.'
                : 'Report a problem or suggest an improvement. We will review it by email.'}
            </p>
          </div>
          <button type="button" className="btn-secondary text-xs" onClick={onClose}>
            Close
          </button>
        </div>

        {sent ? (
          <div className="space-y-4">
            <p className="body-text">Thanks — your message was sent.</p>
            <button type="button" className="btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <form className="space-y-3" onSubmit={handleSubmit}>
            <label className="block space-y-1">
              <span className="subheading">Message</span>
              <textarea
                required
                minLength={3}
                rows={initialMessage ? 10 : 5}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="What should we know or improve?"
                className="field w-full text-sm"
              />
            </label>
            <label className="block space-y-1">
              <span className="subheading">Name (optional)</span>
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="field w-full text-sm"
              />
            </label>
            <label className="block space-y-1">
              <span className="subheading">Email (optional)</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="So we can reply"
                className="field w-full text-sm"
              />
            </label>

            {mutation.isError ? (
              <p className="text-sm text-negative">
                {mutation.error instanceof Error
                  ? mutation.error.message
                  : 'Could not send feedback.'}
              </p>
            ) : null}

            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className="btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn-primary"
                disabled={mutation.isPending || message.trim().length < 3}
              >
                {mutation.isPending ? 'Sending...' : 'Send'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
