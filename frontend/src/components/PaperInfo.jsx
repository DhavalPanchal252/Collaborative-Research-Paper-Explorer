// src/components/sidebar/PaperInfo.jsx
export default function PaperInfo({ uploadedFile, uploadMeta, onReset }) {
  const fileName = uploadedFile?.name ?? "";
  const fileSizeKB = uploadedFile ? (uploadedFile.size / 1024).toFixed(0) : "—";
  const chunks = uploadMeta?.chunks_created ?? "—";

  const displayName =
    fileName.length > 26 ? fileName.slice(0, 23) + "..." : fileName;

  return (
    <div className="paper-info">
      <div className="paper-info-file">
        <span className="paper-info-icon">📄</span>
        <span className="paper-info-name" title={fileName}>
          {displayName}
        </span>
      </div>

      <div className="paper-info-meta">
        <span className="paper-meta-chip">{chunks} chunks</span>
        <span className="paper-meta-chip">{fileSizeKB} KB</span>
      </div>

      <button className="btn-ghost btn-ghost--sm" onClick={onReset}>
        ↩ Replace paper
      </button>
    </div>
  );
}