package org.json;
import java.util.LinkedHashMap;
import java.util.Map;
/** Pengganti org.json Android untuk uji di komputer (hanya yang dipakai pemindai). */
public class JSONObject {
    final Map<String, Object> m = new LinkedHashMap<String, Object>();
    public JSONObject put(String k, Object v) throws JSONException { m.put(k, v); return this; }
    public JSONObject put(String k, int v) throws JSONException { m.put(k, v); return this; }
    public JSONObject put(String k, boolean v) throws JSONException { m.put(k, v); return this; }
    public String optString(String k) { Object v = m.get(k); return v == null ? "" : String.valueOf(v); }
    public boolean optBoolean(String k) { return Boolean.TRUE.equals(m.get(k)); }
    public static String quote(String s) { return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""; }
    @Override public String toString() {
        StringBuilder b = new StringBuilder("{");
        for (Map.Entry<String, Object> e : m.entrySet()) { if (b.length() > 1) b.append(','); b.append(quote(e.getKey())).append(':'); Object v = e.getValue(); b.append(v instanceof String ? quote((String) v) : String.valueOf(v)); }
        return b.append('}').toString();
    }
}
