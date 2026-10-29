package org.json;
import java.util.ArrayList;
import java.util.List;
public class JSONArray {
    final List<Object> l = new ArrayList<Object>();
    public JSONArray put(Object v) { l.add(v); return this; }
    public int length() { return l.size(); }
    @Override public String toString() { StringBuilder b = new StringBuilder("["); for (Object v : l) { if (b.length() > 1) b.append(','); b.append(v instanceof String ? JSONObject.quote((String) v) : String.valueOf(v)); } return b.append(']').toString(); }
}
