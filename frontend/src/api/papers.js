import { supabase } from "../supabase";

const BASE_URL = "http://127.0.0.1:8000";

export async function getMyPapers() {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const token = session?.access_token;

  const res = await fetch(`${BASE_URL}/api/v1/my-papers`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  return res.json();
}