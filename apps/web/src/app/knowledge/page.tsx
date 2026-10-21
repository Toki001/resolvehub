import { KnowledgeDocumentsDocument, KnowledgeSearchDocument } from '@resolvehub/generated';
import { graph } from '@/lib/workspace-api';
import { documentsSchema, searchSchema } from '@/lib/workspace-schemas';
import {
  PageHeading,
  workspaceAccess,
  AccessPanel,
  WorkspaceIssue,
  StatusPill,
  Pager,
  Stamp,
} from '@/components/workspace-ui';
import { DocumentUpload } from '@/components/document-upload';
export const metadata = { title: 'Knowledge Base' };
export default async function Knowledge({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const heading = (
    <PageHeading
      title="Knowledge Base"
      description="Published sources give support drafts something reliable to stand on."
    />
  );
  const access = await workspaceAccess();
  if (access.kind !== 'connected')
    return (
      <div className="page-content">
        {heading}
        <AccessPanel access={access} />
      </div>
    );
  try {
    const params = await searchParams;
    const data = await graph(
      KnowledgeDocumentsDocument,
      { first: 20, after: params.after ?? null },
      documentsSchema,
    );
    const search = params.query
      ? await graph(
          KnowledgeSearchDocument,
          { query: params.query, first: 20, after: params.searchAfter ?? null },
          searchSchema,
        )
      : null;
    return (
      <div className="page-content">
        {heading}
        <section className="content-card">
          <h2>Search published knowledge</h2>
          <form className="filter-form">
            <label>
              Search evidence
              <input
                name="query"
                defaultValue={params.query}
                required
                maxLength={200}
                placeholder="Search source text"
              />
            </label>
            <button className="secondary-button">Search knowledge</button>
          </form>
          {search && (
            <div className="search-results">
              {search.knowledgeSearch.edges.map(({ node: m }) => (
                <article key={m.chunkId}>
                  <h3>{m.title}</h3>
                  <p className="preserve-text">{m.excerpt}</p>
                  <details>
                    <summary>Source version</summary>
                    <p>{m.versionId}</p>
                  </details>
                </article>
              ))}
              {!search.knowledgeSearch.edges.length && (
                <p>No published evidence matches this search.</p>
              )}
              {search.knowledgeSearch.pageInfo.hasNextPage && (
                <a
                  className="text-link"
                  href={`/knowledge?query=${encodeURIComponent(params.query ?? '')}&searchAfter=${encodeURIComponent(search.knowledgeSearch.pageInfo.endCursor ?? '')}`}
                >
                  More search results →
                </a>
              )}
            </div>
          )}
        </section>
        <section className="list-panel">
          <div className="list-heading">
            <div>
              <h2>Knowledge documents</h2>
              <p>New versions publish only after validation and indexing succeed.</p>
            </div>
            <a className="secondary-button" href="/knowledge">
              Refresh documents
            </a>
          </div>
          {data.knowledgeDocuments.edges.length ? (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Document</th>
                    <th>Status</th>
                    <th className="optional-column">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {data.knowledgeDocuments.edges.map(({ node: d }) => (
                    <tr key={d.id}>
                      <td>
                        <strong>{d.title}</strong>
                        {d.activeVersionId && (
                          <details>
                            <summary>Published version</summary>
                            <p>{d.activeVersionId}</p>
                          </details>
                        )}
                      </td>
                      <td>
                        <StatusPill status={d.status} />
                      </td>
                      <td className="optional-column">
                        <Stamp value={d.createdAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="record-empty">
              <h3>No knowledge documents yet</h3>
              <p>Upload a support policy or guide to create the first versioned index.</p>
            </div>
          )}
          <Pager base="/knowledge" info={data.knowledgeDocuments.pageInfo} />
        </section>
        {access.identity.role !== 'analyst' && (
          <section className="content-card" id="upload">
            <h2>Upload knowledge</h2>
            <p>
              Files are staged privately under your verified organization. Indexing runs in the
              background.
            </p>
            <DocumentUpload
              documents={data.knowledgeDocuments.edges.map(({ node }) => ({
                id: node.id,
                title: node.title,
              }))}
            />
          </section>
        )}
      </div>
    );
  } catch (error) {
    return (
      <div className="page-content">
        {heading}
        <WorkspaceIssue error={error} />
      </div>
    );
  }
}
