-- Statistics maintenance stays behind a restricted function, not runtime DDL privileges.
CREATE FUNCTION crm_analyze_business() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE tbl text; BEGIN
  IF coalesce(current_setting('crm.role',true),'') NOT IN ('admin','system') THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
  FOREACH tbl IN ARRAY ARRAY['crm_customer','crm_contact','crm_lead','crm_opportunity','crm_contract','crm_order','crm_payment','crm_follow_up','bi_sales_daily','crm_audit'] LOOP
    EXECUTE format('ANALYZE public.%I',tbl);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION crm_analyze_business() FROM PUBLIC;

