import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { Attachment, TransactionKind } from '../../types';
import { FilePreviewModal, isPreviewableFile } from './FilePreviewModal';

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp';

export function TransactionAttachmentsField({
  kind,
  transactionId,
  pendingFiles = [],
  onPendingFilesChange,
}: {
  kind: TransactionKind;
  transactionId?: string | null;
  pendingFiles?: File[];
  onPendingFilesChange?: (files: File[]) => void;
}) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const savedQuery = useQuery({
    queryKey: ['attachments', kind, transactionId],
    queryFn: () => api.listAttachments(kind, transactionId!),
    enabled: Boolean(transactionId),
  });
  const addMutation = useMutation({
    mutationFn: (file: File) => api.addAttachment(kind, transactionId!, file),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['attachments', kind, transactionId] });
      void queryClient.invalidateQueries({ queryKey: ['deposits'] });
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
      void queryClient.invalidateQueries({ queryKey: ['bank-reconcile-session'] });
    },
  });
  const removeMutation = useMutation({
    mutationFn: (attachmentId: string) =>
      api.removeAttachment(kind, transactionId!, attachmentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['attachments', kind, transactionId] });
      void queryClient.invalidateQueries({ queryKey: ['deposits'] });
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
      void queryClient.invalidateQueries({ queryKey: ['bank-reconcile-session'] });
    },
  });

  const saved = savedQuery.data ?? [];
  const busy = addMutation.isPending || removeMutation.isPending;

  function addLocal(files: FileList | null) {
    if (!files?.length) return;
    const next = [...pendingFiles, ...Array.from(files)];
    onPendingFilesChange?.(next);
  }

  async function addSaved(files: FileList | null) {
    if (!files?.length || !transactionId) return;
    for (const file of Array.from(files)) {
      await addMutation.mutateAsync(file);
    }
  }

  return (
    <div className="space-y-2">
      <span className="label-text">Files</span>
      {saved.length ? (
        <ul className="space-y-1">
          {saved.map((file) => (
            <li key={file.id} className="flex items-center gap-2 text-sm">
              <button
                type="button"
                className="min-w-0 truncate text-left underline-offset-2 hover:underline"
                onClick={() =>
                  isPreviewableFile(file.filename)
                    ? setPreview(file)
                    : window.open(api.getUploadFileUrl(file.upload_id, { download: true }))
                }
              >
                {file.filename}
              </button>
              <button
                type="button"
                className="btn-secondary text-xs"
                disabled={busy}
                onClick={() => removeMutation.mutate(file.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {pendingFiles.length ? (
        <ul className="space-y-1">
          {pendingFiles.map((file, index) => (
            <li key={`${file.name}-${index}`} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 truncate">{file.name}</span>
              <button
                type="button"
                className="btn-secondary text-xs"
                onClick={() =>
                  onPendingFilesChange?.(pendingFiles.filter((_, i) => i !== index))
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {!saved.length && !pendingFiles.length ? (
        <p className="text-xs muted-text">No files yet. Receipt, invoice, or photo.</p>
      ) : null}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        className="sr-only"
        onChange={(event) => {
          const files = event.target.files;
          if (transactionId) {
            void addSaved(files);
          } else {
            addLocal(files);
          }
          event.target.value = '';
        }}
      />
      <button
        type="button"
        className="btn-secondary text-xs"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? 'Uploading…' : 'Add files'}
      </button>
      {preview ? (
        <FilePreviewModal
          uploadId={preview.upload_id}
          filename={preview.filename}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </div>
  );
}
