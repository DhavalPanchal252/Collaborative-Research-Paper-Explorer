import { supabase } from "../supabase";  // 👈 ADD THIS

const BASE_URL = "";

export async function uploadPDF(file) {
  const formData = new FormData();
  formData.append("file", file);

  // 🔥 GET CURRENT SESSION
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const token = session?.access_token;

  const res = await fetch(`${BASE_URL}/api/v1/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,   // 🔥 THIS IS THE KEY LINE
    },
    body: formData,
  });

  if (!res.ok) {
    let message = `Upload failed (${res.status})`;
    try {
      const err = await res.json();
      message = err.detail ?? message;
    } catch {}
    throw new Error(message);
  }

  const data = await res.json();

  localStorage.setItem("session_id", data.session_id);

  return data;
}