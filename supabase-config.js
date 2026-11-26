import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://riezysyqsqvtaklpukct.supabase.co";
const SUPABASE_KEY = "sb_publishable_FMn60ehHIQeczdTuD1yhew_NgurzN0J";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export const topics = {
  public: (pin) => `quiz-${pin}`,
  inbox:  (pin) => `quiz-${pin}-host`,
};
