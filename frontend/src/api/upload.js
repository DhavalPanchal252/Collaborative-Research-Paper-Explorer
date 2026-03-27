const BASE_URL = "";
/**
 * Upload a PDF file to the backend.
 * @param {File} file
 * @returns {Promise<{ filename: string, stored_as: string, chunks_created: number, file_size_bytes: number }>}
 */
export async function uploadPDF(file) {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`${BASE_URL}/api/v1/upload`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    let message = `Upload failed (${res.status})`;
    try {
      const err = await res.json();
      message = err.detail ?? message;
    } catch {
      // ignore parse error
    }
    throw new Error(message);
  }

  const data = await res.json();

  // save session_id globally
  localStorage.setItem("session_id", data.session_id);

  return data;
}
