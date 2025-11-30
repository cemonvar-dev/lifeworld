// ===== Supabase config =====
const SUPABASE_URL = "https://baswgycuhblyppvvdpay.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhc3dneWN1aGJseXBwdnZkcGF5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM5MjEwMjEsImV4cCI6MjA3OTQ5NzAyMX0.ca23kyoMFHDcTvYRGEd8Dh32Y_3AoHj22-OFVxJZTMY";

const supa = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);