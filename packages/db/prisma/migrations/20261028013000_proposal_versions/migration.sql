ALTER TABLE "proposals"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "contentHash" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "approvedVersion" INTEGER,
  ADD COLUMN "approvedContentHash" TEXT;

-- Keep the canonical array identical to JSON.stringify in proposalContentHash.
CREATE FUNCTION proposal_content_hash(kind TEXT, title TEXT, summary TEXT, options TEXT[], recommendation TEXT)
RETURNS TEXT LANGUAGE SQL IMMUTABLE STRICT AS $$
  SELECT encode(sha256(convert_to('[' || to_json(kind)::text || ',' || to_json(title)::text || ',' ||
    to_json(summary)::text || ',' || array_to_json(options)::text || ',' ||
    to_json(recommendation)::text || ']', 'UTF8')), 'hex');
$$;

UPDATE "proposals" SET "contentHash" = proposal_content_hash(kind, title, summary, options, recommendation);
UPDATE "proposals" SET "approvedVersion" = version, "approvedContentHash" = "contentHash"
  WHERE status = 'approved';

-- Every content writer, including scripts, invalidates the previous decision.
CREATE FUNCTION proposal_version_content() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW."contentHash" := proposal_content_hash(NEW.kind, NEW.title, NEW.summary, NEW.options, NEW.recommendation);
  IF TG_OP = 'INSERT' THEN
    NEW.version := 1;
  ELSIF ROW(NEW.kind, NEW.title, NEW.summary, NEW.options, NEW.recommendation)
    IS DISTINCT FROM ROW(OLD.kind, OLD.title, OLD.summary, OLD.options, OLD.recommendation) THEN
    NEW.version := OLD.version + 1;
    NEW.status := 'pending';
    NEW."chosenOption" := NULL;
    NEW.comment := NULL;
    NEW."decidedAt" := NULL;
    NEW."approvedVersion" := OLD."approvedVersion";
    NEW."approvedContentHash" := OLD."approvedContentHash";
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER proposal_version_content BEFORE INSERT OR UPDATE ON "proposals"
  FOR EACH ROW EXECUTE FUNCTION proposal_version_content();
