import { createClient } from "@supabase/supabase-js";

const supabaseUrl ="https://bibxgypzpevuoqyuaaig.supabase.co";
const supabaseKey ="sb_publishable_nli4VqorEAa6CGj-V0lsMw_Iw9DP4qQ";

export const supabase = createClient(supabaseUrl, supabaseKey);