import { useEffect } from 'react';
import { api } from '../../api/client';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);
const PREVIEW_EXT = new Set([...IMAGE_EXT, 'pdf']);

function fileExtension(filename: string | null | undefined): string {
  if (!filename) return '';
  const parts = filename.toLowerCase().split('.');
  return parts.length > 1 ? parts[parts.length - 1]! : '';
}

export function isPreviewableFile(filename: string | null | undefined): boolean {
  return PREVIEW_EXT.has(fileExtension(filename));
}

function isImageFile(filename: string | null | undefined): boolean {
  return IMAGE_EXT.has(fileExtension(filename));
}

type FilePreviewModalProps = {
  uploadId: string;
  filename?: string | null;
  onClose: () => void;
};

export function FilePreviewModal({ uploadId, filename, onClose }: FilePreviewModalProps) {
  const inlineUrl = api.getUploadFileUrl(uploadId);
  const downloadUrl = api.getUploadFileUrl(uploadId, { download: true });
  const title = filename || 'File preview';
  const image = isImageFile(filename);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-700">
          <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100" title={title}>
            {title}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <a href={downloadUrl} download={filename || undefined} className="btn-secondary text-xs">
              Download
            </a>
            <button type="button" className="btn-secondary text-xs" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-slate-50 p-3 dark:bg-slate-950/50">
          {image ? (
            <img
              src={inlineUrl}
              alt={title}
              className="mx-auto max-h-[75vh] max-w-full object-contain"
            />
          ) : (
            <iframe
              title={title}
              src={inlineUrl}
              className="h-[75vh] w-full rounded-md border border-slate-200 bg-white dark:border-slate-700"
            />
          )}
        </div>
      </div>
    </div>
  );
}
