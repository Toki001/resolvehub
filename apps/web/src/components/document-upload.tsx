'use client';
import { useState } from 'react';
import { ActionForm } from './action-form';
import { uploadDocument } from '@/lib/actions';
export function DocumentUpload({ documents }: { documents: { id: string; title: string }[] }) {
  const [id, setId] = useState('');
  return (
    <ActionForm
      action={uploadDocument}
      label={id ? 'Upload new version' : 'Upload & index document'}
      reset={false}
    >
      <label>
        Destination
        <select name="documentId" value={id} onChange={(e) => setId(e.target.value)}>
          <option value="">New document</option>
          {documents.map((d) => (
            <option key={d.id} value={d.id}>
              New version: {d.title}
            </option>
          ))}
        </select>
      </label>
      {!id && (
        <label>
          Document title
          <input name="title" required maxLength={200} />
        </label>
      )}
      <label>
        Source file
        <input
          type="file"
          name="file"
          required
          accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf"
        />
      </label>
      <p className="muted">
        PDF, plain text or Markdown, up to 10 MiB. A failed new version preserves the previously
        published index.
      </p>
    </ActionForm>
  );
}
