CREATE OR REPLACE FUNCTION proposal_content_hash(kind TEXT, title TEXT, summary TEXT, options TEXT[], recommendation TEXT)
RETURNS TEXT LANGUAGE SQL IMMUTABLE CALLED ON NULL INPUT AS $$
  SELECT encode(sha256(convert_to('[' || COALESCE(to_json(kind)::text, 'null') || ',' ||
    COALESCE(to_json(title)::text, 'null') || ',' ||
    COALESCE(to_json(summary)::text, 'null') || ',' ||
    array_to_json(COALESCE(options, '{}'))::text || ',' ||
    COALESCE(to_json(recommendation)::text, 'null') || ']', 'UTF8')), 'hex');
$$;
