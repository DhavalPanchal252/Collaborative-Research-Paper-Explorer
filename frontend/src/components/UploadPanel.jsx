import { useRef, useState } from "react";

export default function UploadPanel({
  onUpload,
  uploading,
  uploadedFile,
  uploadMeta,
  error,
  onReset,
}) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  function handleFile(file) {
    if (!file) return;
    if (file.type !== "application/pdf") {
      alert("Only PDF files are supported.");
      return;
    }
    onUpload(file);
  }

  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    handleFile(file);
  }

  if (uploadedFile) {
    return (
      <div className="upload-success">
        <div className="upload-success-icon">✓</div>
        <p className="upload-filename" title={uploadedFile.name}>
          {uploadedFile.name.length > 28
            ? uploadedFile.name.slice(0, 25) + "..."
            : uploadedFile.name}
        </p>
        <p className="upload-sub">{uploadMeta?.chunks_created} chunks · {(uploadedFile.size / 1024).toFixed(0)} KB</p>
        <button className="btn-ghost" onClick={onReset}>
          Replace paper
        </button>
      </div>
    );
  }

  return (
    <div
      className={`dropzone ${dragging ? "dropzone--active" : ""} ${uploading ? "dropzone--loading" : ""}`}
      onClick={() => !uploading && inputRef.current.click()}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        style={{ display: "none" }}
        onChange={(e) => handleFile(e.target.files[0])}
      />

      {uploading ? (
        <div className="dropzone-uploading">
          <span className="spinner" />
          <span>Parsing & indexing…</span>
        </div>
      ) : (
        <>
          <span className="dropzone-icon">⬆</span>
          <p className="dropzone-label">Drop PDF or click</p>
          <p className="dropzone-sub">Max 20 MB</p>
        </>
      )}

      {error && <p className="upload-error">{error}</p>}
    </div>
  );
}
