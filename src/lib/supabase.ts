import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabasePublishableKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error(
    "Supabase 환경 변수가 설정되지 않았습니다. VITE_SUPABASE_URL과 VITE_SUPABASE_PUBLISHABLE_KEY를 확인하세요.",
  );
}

export const supabase = createClient(
  supabaseUrl,
  supabasePublishableKey,
);
