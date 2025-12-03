--
-- PostgreSQL database dump
--

\restrict ZBDTiQxQqIZQVrJsvlC0s2uKYDURczCZDwoPjynoFurOsn2l6QiVWrAIDJHgBZc

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: api; Type: SCHEMA; Schema: -; Owner: geohuz
--

CREATE SCHEMA api;


ALTER SCHEMA api OWNER TO geohuz;

--
-- Name: auth; Type: SCHEMA; Schema: -; Owner: geohuz
--

CREATE SCHEMA auth;


ALTER SCHEMA auth OWNER TO geohuz;

--
-- Name: data; Type: SCHEMA; Schema: -; Owner: geohuz
--

CREATE SCHEMA data;


ALTER SCHEMA data OWNER TO geohuz;

--
-- Name: internal; Type: SCHEMA; Schema: -; Owner: geohuz
--

CREATE SCHEMA internal;


ALTER SCHEMA internal OWNER TO geohuz;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: pgjwt; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgjwt WITH SCHEMA public;


--
-- Name: jwt_token; Type: TYPE; Schema: auth; Owner: geohuz
--

CREATE TYPE auth.jwt_token AS (
	token text
);


ALTER TYPE auth.jwt_token OWNER TO geohuz;

--
-- Name: activate_portkey_config(uuid, text, uuid); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.activate_portkey_config(p_id uuid, p_reason text, p_activated_by uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    current_tenant_id uuid;
    current_user_id uuid;
    current_version integer;
    current_config_json jsonb;
BEGIN
    SELECT tenant_id, user_id, version, config_json
    INTO current_tenant_id, current_user_id, current_version, current_config_json
    FROM data.portkey_configs WHERE id = p_id FOR UPDATE;

    IF current_version IS NULL THEN
        RAISE EXCEPTION 'Config not found';
    END IF;

    UPDATE data.portkey_configs
    SET is_active = true,
        effective_to = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = p_id;

    -- 🆕 激活通知
    PERFORM pg_notify('config_update', 
        jsonb_build_object(
            'action', 'activate',
            'config_id', p_id,
            'tenant_id', current_tenant_id,
            'user_id', current_user_id,
            'config_json', current_config_json,
            'version', current_version,
            'reason', p_reason,
            'timestamp', extract(epoch from now())::text
        )::text
    );
END;
$$;


ALTER FUNCTION api.activate_portkey_config(p_id uuid, p_reason text, p_activated_by uuid) OWNER TO geohuz;

--
-- Name: activate_virtual_key(text, text); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.activate_virtual_key(p_virtual_key text, p_reason text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_virtual_key_id UUID;
    v_user_id UUID;
    v_key_data jsonb;
BEGIN
    SELECT id, user_id,
           jsonb_build_object(
               'name', name,
               'rate_limit_rpm', rate_limit_rpm,
               'rate_limit_tpm', rate_limit_tpm,
               'allowed_models', allowed_models
           ) INTO v_virtual_key_id, v_user_id, v_key_data
    FROM data.virtual_key 
    WHERE virtual_key = p_virtual_key
    FOR UPDATE;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Virtual key not found: %', p_virtual_key;
    END IF;
    
    UPDATE data.virtual_key 
    SET is_active = true,
        updated_at = NOW(),
        description = COALESCE(description, '') || ' - Reactivated: ' || p_reason
    WHERE virtual_key = p_virtual_key;
    
    -- 🆕 激活通知
    PERFORM pg_notify('virtual_key_update', 
        jsonb_build_object(
            'action', 'activate',
            'virtual_key_id', v_virtual_key_id,
            'virtual_key', p_virtual_key,
            'user_id', v_user_id,
            'key_data', v_key_data,
            'reason', p_reason,
            'timestamp', extract(epoch from now())::text
        )::text
    );
END;
$$;


ALTER FUNCTION api.activate_virtual_key(p_virtual_key text, p_reason text) OWNER TO geohuz;

--
-- Name: attach_virtualkey(uuid, uuid); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.attach_virtualkey(p_virtual_key_id uuid, p_config_node_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- 只更新 primary_config_node_id，触发器自动处理 computed_config 和通知
    UPDATE data.virtual_key
    SET primary_config_node_id = p_config_node_id
    WHERE id = p_virtual_key_id;
END;
$$;


ALTER FUNCTION api.attach_virtualkey(p_virtual_key_id uuid, p_config_node_id uuid) OWNER TO geohuz;

--
-- Name: blacklist_user(uuid, text); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.blacklist_user(p_user_id uuid, p_reason text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_log_id UUID;
    v_old_status TEXT;
    v_admin_id UUID;
BEGIN
    -- 获取管理员ID（去掉权限检查）
    v_admin_id := (current_setting('request.jwt.claims', true)::json->>'userid')::UUID;

    -- 获取当前状态
    SELECT status INTO v_old_status
    FROM data.user_profile 
    WHERE user_id = p_user_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User not found: %', p_user_id;
    END IF;

    -- 调用内部状态变更
    PERFORM internal.change_user_status(p_user_id, 'blacklisted');
    
    -- 记录审计日志 - 使用 audit_log 表实际存在的字段
    INSERT INTO data.audit_log (
        actor_id, 
        action, 
        target_id,           -- 使用 target_id 而不是 target_user_id
        detail               -- 将所有额外信息放在 detail JSONB 中
    ) VALUES (
        v_admin_id,
        'blacklist_user',
        p_user_id,
        jsonb_build_object(
            'old_status', v_old_status,
            'new_status', 'blacklisted', 
            'reason', p_reason
        )
    ) RETURNING id INTO v_log_id;

    
    RETURN v_log_id;
END;
$$;


ALTER FUNCTION api.blacklist_user(p_user_id uuid, p_reason text) OWNER TO geohuz;

--
-- Name: build_portkey_metadata(uuid); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.build_portkey_metadata(p_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    metadata jsonb;
BEGIN
    SELECT jsonb_build_object(
        'user_id', p_user_id,
        'user_tier', up.status,  -- 假设 status 是 tier
        'tenant_id', up.tenant_id
    ) INTO metadata
    FROM data.user_profile up
    WHERE up.user_id = p_user_id;

    RETURN metadata;
END;
$$;


ALTER FUNCTION api.build_portkey_metadata(p_user_id uuid) OWNER TO geohuz;

--
-- Name: cancel_user(uuid, text); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.cancel_user(p_user_id uuid, p_reason text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_log_id UUID;
    v_old_status TEXT;
    v_admin_id UUID;
BEGIN
    -- 获取管理员ID
    v_admin_id := (current_setting('request.jwt.claims', true)::json->>'userid')::UUID;

    -- 获取当前状态
    SELECT status INTO v_old_status
    FROM data.user_profile 
    WHERE user_id = p_user_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User not found: %', p_user_id;
    END IF;

    -- 调用内部状态变更
    PERFORM internal.change_user_status(p_user_id, 'canceled');
    
    -- 记录审计日志
    INSERT INTO data.audit_log (
        actor_id, 
        action, 
        target_id,
        detail
    ) VALUES (
        v_admin_id,
        'cancel_user',
        p_user_id,
        jsonb_build_object(
            'old_status', v_old_status,
            'new_status', 'canceled', 
            'reason', p_reason
        )
    ) RETURNING id INTO v_log_id;
    
    RETURN v_log_id;
END;
$$;


ALTER FUNCTION api.cancel_user(p_user_id uuid, p_reason text) OWNER TO geohuz;

--
-- Name: check_user_access(uuid); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.check_user_access(p_user_id uuid) RETURNS TABLE(can_use_api boolean, can_generate_key boolean, user_status text, message text, username text, email text)
    LANGUAGE sql SECURITY DEFINER
    AS $$
    SELECT 
        -- can_use_api: 只有 active 和 free_period 可以使用 API
        up.status IN ('active', 'free_period'),
        
        -- can_generate_key: active, free_period  
        up.status IN ('active', 'free_period'),
        
        up.status,
        
        -- 提示消息
        CASE up.status
            WHEN 'blacklisted' THEN '账户已被封禁'
            WHEN 'overdue' THEN '账户欠费，请及时充值'
            WHEN 'pending' THEN '账户待激活，请完成充值'
            WHEN 'free_period' THEN '免费使用期'
            ELSE ''
        END as message,
        
        up.username,
        l.email
    FROM data.user_profile up
    JOIN auth.login l ON up.user_id = l.id
    WHERE up.user_id = p_user_id;
$$;


ALTER FUNCTION api.check_user_access(p_user_id uuid) OWNER TO geohuz;

--
-- Name: cleanup_test_data(); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.cleanup_test_data() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    DELETE FROM data.unified_config_store WHERE level_name LIKE 'test_%';
    DELETE FROM data.inheritance_rules WHERE parent_level LIKE 'test_%' OR child_level LIKE 'test_%';
    DELETE FROM data.tier_feature_mappings WHERE tier_name LIKE 'test_%';
    DELETE FROM data.tier_definitions WHERE tier_name LIKE 'test_%';
    DELETE FROM data.config_types WHERE type_name IN (
        'gateway_routing', 'rate_limits', 'model_access', 'billing_rules',
        'security_policy', 'content_filters', 'cache_strategy'
    );
    DELETE FROM data.config_levels WHERE level_name LIKE 'test_%';
END;
$$;


ALTER FUNCTION api.cleanup_test_data() OWNER TO geohuz;

--
-- Name: config_create(text, text, jsonb, uuid, timestamp with time zone, timestamp with time zone); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.config_create(p_config_type text, p_level_name text, p_config_value jsonb, p_scope_id uuid DEFAULT NULL::uuid, p_effective_from timestamp with time zone DEFAULT now(), p_effective_to timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_config_id UUID;
BEGIN
    -- 验证配置类型存在
    IF NOT EXISTS (SELECT 1 FROM data.config_types WHERE type_name = p_config_type) THEN
        RAISE EXCEPTION '配置类型不存在: %', p_config_type;
    END IF;
    
    -- 验证层级存在
    IF NOT EXISTS (SELECT 1 FROM data.config_levels WHERE level_name = p_level_name) THEN
        RAISE EXCEPTION '配置层级不存在: %', p_level_name;
    END IF;
    
    -- 插入配置
    INSERT INTO data.unified_config_store (
        config_type, level_name, scope_id, config_value,
        effective_from, effective_to
    ) VALUES (
        p_config_type, p_level_name, p_scope_id, p_config_value,
        p_effective_from, p_effective_to
    )
    RETURNING id INTO v_config_id;
    
    -- 通知配置更新
    PERFORM pg_notify('config_updates', 
        jsonb_build_object(
            'action', 'create',
            'config_type', p_config_type,
            'level_name', p_level_name,
            'scope_id', p_scope_id,
            'config_id', v_config_id
        )::text
    );
    
    RETURN v_config_id;
END;
$$;


ALTER FUNCTION api.config_create(p_config_type text, p_level_name text, p_config_value jsonb, p_scope_id uuid, p_effective_from timestamp with time zone, p_effective_to timestamp with time zone) OWNER TO geohuz;

--
-- Name: config_delete(text, text, uuid); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.config_delete(p_config_type text, p_level_name text, p_scope_id uuid DEFAULT NULL::uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    UPDATE data.unified_config_store
    SET effective_to = NOW()
    WHERE config_type = p_config_type
      AND level_name = p_level_name
      AND scope_id IS NOT DISTINCT FROM p_scope_id
      AND (effective_to IS NULL OR effective_to > NOW());
    
    PERFORM pg_notify('config_updates', 
        jsonb_build_object(
            'action', 'delete',
            'config_type', p_config_type,
            'level_name', p_level_name,
            'scope_id', p_scope_id
        )::text
    );
    
    RETURN FOUND;
END;
$$;


ALTER FUNCTION api.config_delete(p_config_type text, p_level_name text, p_scope_id uuid) OWNER TO geohuz;

--
-- Name: config_update(text, text, jsonb, uuid, text); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.config_update(p_config_type text, p_level_name text, p_config_value jsonb, p_scope_id uuid DEFAULT NULL::uuid, p_version_notes text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_config_id UUID;
    v_old_version INTEGER;
BEGIN
    -- 获取当前版本
    SELECT version INTO v_old_version
    FROM data.unified_config_store
    WHERE config_type = p_config_type
      AND level_name = p_level_name
      AND scope_id IS NOT DISTINCT FROM p_scope_id
      AND (effective_to IS NULL OR effective_to > NOW())
    ORDER BY version DESC
    LIMIT 1;
    
    -- 失效旧配置
    UPDATE data.unified_config_store
    SET effective_to = NOW()
    WHERE config_type = p_config_type
      AND level_name = p_level_name
      AND scope_id IS NOT DISTINCT FROM p_scope_id
      AND (effective_to IS NULL OR effective_to > NOW());
    
    -- 创建新版本
    INSERT INTO data.unified_config_store (
        config_type, level_name, scope_id, config_value,
        version, version_notes
    ) VALUES (
        p_config_type, p_level_name, p_scope_id, p_config_value,
        COALESCE(v_old_version, 0) + 1, p_version_notes
    )
    RETURNING id INTO v_config_id;
    
    PERFORM pg_notify('config_updates', 
        jsonb_build_object(
            'action', 'update',
            'config_type', p_config_type,
            'level_name', p_level_name,
            'scope_id', p_scope_id,
            'config_id', v_config_id
        )::text
    );
    
    RETURN v_config_id;
END;
$$;


ALTER FUNCTION api.config_update(p_config_type text, p_level_name text, p_config_value jsonb, p_scope_id uuid, p_version_notes text) OWNER TO geohuz;

--
-- Name: confirm_topup(uuid); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.confirm_topup(p_topup_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    rec data.topup_record%ROWTYPE;
    v_user_status text;
    v_new_balance numeric;
    v_recovery_threshold numeric;
BEGIN
    v_recovery_threshold := internal.get_numeric_config('overdue_recovery_threshold', 0);

    SELECT * INTO rec
    FROM data.topup_record
    WHERE id = p_topup_id
    FOR UPDATE;

    IF rec.status <> 'pending' THEN
        RAISE EXCEPTION 'Topup already confirmed or invalid.';
    END IF;

    -- 检查用户状态
    SELECT status INTO v_user_status
    FROM data.user_profile 
    WHERE user_id = rec.user_id;
    
    IF v_user_status IN ('blacklisted', 'canceled') THEN
        RAISE EXCEPTION 'User account is % and cannot receive topups', v_user_status;
    END IF;

    -- 更新记录状态
    UPDATE data.topup_record
    SET status = 'success', updated_at = now()
    WHERE id = p_topup_id;

    -- 更新余额
    INSERT INTO data.account_balance(user_id, balance)
    VALUES (rec.user_id, rec.amount)
    ON CONFLICT (user_id)
    DO UPDATE SET balance = data.account_balance.balance + rec.amount;

    -- 写账单
    INSERT INTO data.billing_event(user_id, event_type, amount, balance_after, description)
    SELECT rec.user_id, 'credit', rec.amount, balance, 'topup confirmed'
    FROM data.account_balance
    WHERE user_id = rec.user_id;

    -- 🆕 获取用户最新状态和余额（修复：使用 COALESCE 处理 NULL）
    SELECT up.status, COALESCE(ab.balance, rec.amount)
    INTO v_user_status, v_new_balance
    FROM data.user_profile up
    LEFT JOIN data.account_balance ab ON up.user_id = ab.user_id
    WHERE up.user_id = rec.user_id;

    -- 🆕 幂等的状态变更逻辑
    IF v_user_status = 'overdue' AND v_new_balance >= v_recovery_threshold THEN
        PERFORM internal.change_user_status(rec.user_id, 'active');
    ELSIF v_user_status = 'pending' AND v_new_balance > 0 THEN
        -- 🆕 修复：pending 用户只要有充值就激活，不管余额具体多少
        PERFORM internal.change_user_status(rec.user_id, 'active');
    END IF;

END;
$$;


ALTER FUNCTION api.confirm_topup(p_topup_id uuid) OWNER TO geohuz;

--
-- Name: create_api_key(uuid); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.create_api_key(p_user_id uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    existing_id uuid;
    key_text text;
BEGIN
    -- 生成随机 API key
    key_text := encode(gen_random_bytes(32), 'hex');

    -- 检查用户是否已有 key
    SELECT id INTO existing_id 
    FROM data.api_key
    WHERE login_id = p_user_id;

    IF existing_id IS NULL THEN
        -- 没有旧 key，则插入新记录
        INSERT INTO data.api_key(login_id, api_key)
        VALUES (p_user_id, key_text)
        RETURNING id INTO existing_id;
    ELSE
        -- 已有 key，则更新
        UPDATE data.api_key
        SET api_key = key_text,
            updated_at = now()
        WHERE id = existing_id;
    END IF;

    RETURN key_text;
END;
$$;


ALTER FUNCTION api.create_api_key(p_user_id uuid) OWNER TO geohuz;

--
-- Name: create_portkey_config(uuid, uuid, text, jsonb, timestamp with time zone, text, uuid); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.create_portkey_config(p_tenant_id uuid, p_user_id uuid, p_config_name text, p_config_json jsonb, p_effective_from timestamp with time zone, p_notes text, p_created_by uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    new_id uuid;
BEGIN
    -- 验证 JSON (简单示例，可用 pg_json_schema 扩展增强)
    IF NOT api.validate_portkey_config_json(p_config_json) THEN
        RAISE EXCEPTION 'Invalid Portkey config JSON';
    END IF;

    INSERT INTO data.portkey_configs (tenant_id, user_id, config_name, config_json, effective_from, notes, created_by)
    VALUES (p_tenant_id, p_user_id, p_config_name, p_config_json, p_effective_from, p_notes, p_created_by)
    RETURNING id INTO new_id;

    -- 插入 history
    INSERT INTO data.portkey_config_history (config_id, tenant_id, user_id, config_json, version, effective_from, changed_by, change_type, notes)
    VALUES (new_id, p_tenant_id, p_user_id, p_config_json, 1, p_effective_from, p_created_by, 'create', p_notes);

    -- 通知更新
    -- 🆕 修复：提供完整的配置更新信息
    PERFORM pg_notify('config_update', 
        jsonb_build_object(
            'action', 'create',
            'config_id', new_id,
            'tenant_id', p_tenant_id,
            'user_id', p_user_id,
            'config_name', p_config_name,
            'version', 1,
            'timestamp', extract(epoch from now())::text
        )::text
    );


    RETURN new_id;
END;
$$;


ALTER FUNCTION api.create_portkey_config(p_tenant_id uuid, p_user_id uuid, p_config_name text, p_config_json jsonb, p_effective_from timestamp with time zone, p_notes text, p_created_by uuid) OWNER TO geohuz;

--
-- Name: create_portkey_template(uuid, text, jsonb, boolean, text, uuid); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.create_portkey_template(p_tenant_id uuid, p_template_name text, p_template_json jsonb, p_is_global boolean, p_notes text, p_created_by uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    new_id uuid;
BEGIN
    IF NOT api.validate_portkey_config_json(p_template_json) THEN
        RAISE EXCEPTION 'Invalid Portkey template JSON';
    END IF;

    INSERT INTO data.portkey_config_templates (tenant_id, template_name, template_json, is_global, notes, created_by)
    VALUES (p_tenant_id, p_template_name, p_template_json, p_is_global, p_notes, p_created_by)
    RETURNING id INTO new_id;

    -- 通知 (可选)
    PERFORM pg_notify('template_update', new_id::text);

    RETURN new_id;
END;
$$;


ALTER FUNCTION api.create_portkey_template(p_tenant_id uuid, p_template_name text, p_template_json jsonb, p_is_global boolean, p_notes text, p_created_by uuid) OWNER TO geohuz;

--
-- Name: create_virtual_key(uuid, text, text, uuid, text); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.create_virtual_key(p_user_id uuid, p_name text, p_description text DEFAULT NULL::text, p_key_type_id uuid DEFAULT NULL::uuid, p_key_prefix text DEFAULT NULL::text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_virtual_key TEXT;
    v_tenant_id UUID;
    v_virtual_key_id UUID;
BEGIN
    -- 生成 virtual key
    v_virtual_key := 'vk_' || encode(gen_random_bytes(16), 'hex');
    
    -- 获取租户ID
    SELECT tenant_id INTO v_tenant_id 
    FROM data.user_profile 
    WHERE user_id = p_user_id;
    
    -- 插入 virtual key 记录（移除了业务配置字段）
    INSERT INTO data.virtual_key (
        user_id, virtual_key, name, description,
        key_type_id, key_prefix, is_active
    ) VALUES (
        p_user_id, v_virtual_key, p_name, p_description,
        p_key_type_id, p_key_prefix, true
    )
    RETURNING id INTO v_virtual_key_id;
    
    -- 通知机制（简化，移除业务配置信息）
    PERFORM pg_notify('virtual_key_update', 
        jsonb_build_object(
            'action', 'create',
            'virtual_key_id', v_virtual_key_id,
            'virtual_key', v_virtual_key,
            'user_id', p_user_id,
            'timestamp', extract(epoch from now())::text
        )::text
    );
    
    -- 审计日志（简化，移除业务配置信息）
    INSERT INTO data.audit_log (
        actor_id, action, target_type, target_id, detail
    ) VALUES (
        p_user_id, 'CREATE_VIRTUAL_KEY', 'virtual_key', 
        v_virtual_key_id,
        jsonb_build_object(
            'name', p_name,
            'virtual_key', v_virtual_key
        )
    );

    RETURN v_virtual_key;
END;
$$;


ALTER FUNCTION api.create_virtual_key(p_user_id uuid, p_name text, p_description text, p_key_type_id uuid, p_key_prefix text) OWNER TO geohuz;

--
-- Name: deactivate_portkey_config(uuid, text, uuid); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.deactivate_portkey_config(p_id uuid, p_reason text, p_deactivated_by uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    current_tenant_id uuid;
    current_user_id uuid;
    current_version integer;
    current_config_json jsonb;
    current_effective_from timestamp with time zone;
BEGIN
    SELECT tenant_id, user_id, version, config_json, effective_from
    INTO current_tenant_id, current_user_id, current_version, current_config_json, current_effective_from
    FROM data.portkey_configs WHERE id = p_id FOR UPDATE;

    IF current_version IS NULL THEN
        RAISE EXCEPTION 'Config not found';
    END IF;

    UPDATE data.portkey_configs
    SET is_active = false,
        effective_to = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = p_id;

    -- 插入 history
    INSERT INTO data.portkey_config_history (config_id, tenant_id, user_id, config_json, version, effective_from, effective_to, changed_by, change_type, notes)
    VALUES (p_id, current_tenant_id, current_user_id, current_config_json, current_version, current_effective_from, CURRENT_TIMESTAMP, p_deactivated_by, 'deactivate', p_reason);

    -- 通知
    PERFORM pg_notify('config_update', 
        jsonb_build_object(
            'action', 'update',
            'config_id', p_id,
            'tenant_id', current_tenant_id,
            'user_id', current_user_id,
            'version', new_version,
            'timestamp', extract(epoch from now())::text
        )::text
    );
END;
$$;


ALTER FUNCTION api.deactivate_portkey_config(p_id uuid, p_reason text, p_deactivated_by uuid) OWNER TO geohuz;

--
-- Name: deactivate_virtual_key(text, text); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.deactivate_virtual_key(p_virtual_key text, p_reason text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_virtual_key_id UUID;
    v_user_id UUID;
BEGIN
    UPDATE data.virtual_key 
    SET is_active = false,
        updated_at = NOW(),
        description = COALESCE(description, '') || ' - Deactivated: ' || p_reason
    WHERE virtual_key = p_virtual_key
    RETURNING id, user_id INTO v_virtual_key_id, v_user_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Virtual key not found: %', p_virtual_key;
    END IF;
    
    -- 🆕 发送停用通知
    PERFORM pg_notify('virtual_key_update', 
        jsonb_build_object(
            'action', 'deactivate',
            'virtual_key_id', v_virtual_key_id,
            'user_id', v_user_id,
            'virtual_key', p_virtual_key,
            'reason', p_reason,
            'timestamp', extract(epoch from now())::text
        )::text
    );
END;
$$;


ALTER FUNCTION api.deactivate_virtual_key(p_virtual_key text, p_reason text) OWNER TO geohuz;

--
-- Name: dynamic_merge_config(jsonb, jsonb, text, text, jsonb); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.dynamic_merge_config(parent_config jsonb, child_config jsonb, p_config_type text, current_level text, context jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    v_merge_strategy TEXT;
    v_custom_strategy TEXT;
    v_default_strategy TEXT;
BEGIN
    -- 如果父配置为空，直接返回子配置
    IF parent_config IS NULL THEN
        RETURN child_config;
    END IF;
    
    -- 如果子配置为空，直接返回父配置
    IF child_config IS NULL THEN
        RETURN parent_config;
    END IF;
    
    -- 查找配置类型的默认合并策略
    SELECT merge_strategy INTO v_default_strategy
    FROM data.config_types
    WHERE type_name = p_config_type;
    
    -- 查找继承规则中的自定义策略
    SELECT ir.custom_merge_strategy INTO v_custom_strategy
    FROM data.inheritance_rules ir
    WHERE ir.config_type = p_config_type
      AND ir.child_level = current_level
      AND ir.is_active = true
      AND (ir.effective_to IS NULL OR ir.effective_to > NOW())
      AND (ir.condition_expression IS NULL OR api.evaluate_condition(ir.condition_expression, context));
    
    -- 确定使用的合并策略（优先使用自定义策略）
    v_merge_strategy := COALESCE(v_custom_strategy, v_default_strategy, 'override');
    
    RAISE NOTICE '    🎯 合并策略: % (自定义: %, 默认: %)', 
        v_merge_strategy, v_custom_strategy, v_default_strategy;
    
    -- 执行合并
    CASE v_merge_strategy
        WHEN 'override' THEN
            RAISE NOTICE '    🔄 使用覆盖策略';
            RETURN child_config;
            
        WHEN 'deep_merge' THEN
            RAISE NOTICE '    🔄 使用深度合并策略';
            RETURN parent_config || child_config;
            
        WHEN 'array_append' THEN
            RAISE NOTICE '    🔄 使用数组追加策略';
            -- 智能数组合并：合并所有数组字段，其他字段使用子配置
            RETURN jsonb_build_object(
                'allowed_models', 
                COALESCE(parent_config->'allowed_models', '[]'::jsonb) || 
                COALESCE(child_config->'allowed_models', '[]'::jsonb)
            ) || (child_config - 'allowed_models');
            
        WHEN 'array_merge' THEN
            RAISE NOTICE '    🔄 使用数组合并策略';
            -- 与 array_append 相同
            RETURN jsonb_build_object(
                'allowed_models', 
                COALESCE(parent_config->'allowed_models', '[]'::jsonb) || 
                COALESCE(child_config->'allowed_models', '[]'::jsonb)
            ) || (child_config - 'allowed_models');
            
        ELSE
            RAISE NOTICE '    ⚠️ 使用默认覆盖策略';
            RETURN child_config;
    END CASE;
END;
$$;


ALTER FUNCTION api.dynamic_merge_config(parent_config jsonb, child_config jsonb, p_config_type text, current_level text, context jsonb) OWNER TO geohuz;

--
-- Name: evaluate_condition(jsonb, jsonb); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.evaluate_condition(condition_expression jsonb, context jsonb) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    v_field TEXT;
    v_operator TEXT;
    v_value JSONB;
    v_context_value JSONB;
    v_result BOOLEAN := false;
BEGIN
    -- 参数验证
    IF condition_expression IS NULL OR context IS NULL THEN
        RETURN false;
    END IF;
    
    -- 提取字段
    BEGIN
        v_field := condition_expression->>'field';
        v_operator := condition_expression->>'operator';
        v_value := condition_expression->'value';
        v_context_value := context->v_field;
    EXCEPTION
        WHEN OTHERS THEN
            RAISE NOTICE '    ⚠️ 条件表达式格式错误: %', condition_expression;
            RETURN false;
    END;
    
    -- 验证必需字段
    IF v_field IS NULL OR v_operator IS NULL THEN
        RAISE NOTICE '    ⚠️ 缺少必需字段: field=%, operator=%', v_field, v_operator;
        RETURN false;
    END IF;
    
    RAISE NOTICE '    🎯 条件评估: field=%, operator=%, value=%, context_value=%', 
        v_field, v_operator, v_value, v_context_value;
    
    -- 健壮的条件评估
    BEGIN
        CASE v_operator
            WHEN 'equals' THEN
                v_result := (v_context_value = v_value);
                
            WHEN 'in' THEN
                IF jsonb_typeof(v_value) = 'array' AND v_context_value IS NOT NULL THEN
                    v_result := EXISTS (
                        SELECT 1 
                        FROM jsonb_array_elements(v_value) AS elem
                        WHERE elem = v_context_value
                    );
                ELSE
                    v_result := false;
                END IF;
                
            WHEN 'not_in' THEN
                IF jsonb_typeof(v_value) = 'array' AND v_context_value IS NOT NULL THEN
                    v_result := NOT EXISTS (
                        SELECT 1 
                        FROM jsonb_array_elements(v_value) AS elem
                        WHERE elem = v_context_value
                    );
                ELSE
                    v_result := false;
                END IF;
                
            WHEN 'greater_than' THEN
                BEGIN
                    v_result := (v_context_value::NUMERIC) > (v_value::NUMERIC);
                EXCEPTION
                    WHEN OTHERS THEN
                        v_result := false;
                END;
                
            WHEN 'less_than' THEN
                BEGIN
                    v_result := (v_context_value::NUMERIC) < (v_value::NUMERIC);
                EXCEPTION
                    WHEN OTHERS THEN
                        v_result := false;
                END;
                
            WHEN 'exists' THEN
                v_result := (context ? v_field);
                
            ELSE
                RAISE NOTICE '    ⚠️ 未知操作符: %', v_operator;
                v_result := false;
        END CASE;
    EXCEPTION
        WHEN OTHERS THEN
            RAISE NOTICE '    ⚠️ 条件评估出错: %', SQLERRM;
            v_result := false;
    END;
    
    RETURN v_result;
END;
$$;


ALTER FUNCTION api.evaluate_condition(condition_expression jsonb, context jsonb) OWNER TO geohuz;

--
-- Name: get_active_portkey_config(uuid, uuid); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.get_active_portkey_config(p_tenant_id uuid, p_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    global_template jsonb;
    tenant_template jsonb;
    user_config jsonb;
    merged jsonb;
BEGIN
    -- 获取全局模板 (is_global=true, tenant_id null)
    SELECT template_json INTO global_template
    FROM data.portkey_config_templates
    WHERE is_global = true AND tenant_id IS NULL
    ORDER BY version DESC LIMIT 1;

    -- 获取 tenant 默认模板
    SELECT t.template_json INTO tenant_template
    FROM data.portkey_config_templates t
    JOIN data.tenant tn ON tn.default_template_id = t.id
    WHERE tn.id = p_tenant_id;

    -- 获取 user config
    SELECT c.config_json INTO user_config
    FROM data.portkey_configs c
    JOIN data.user_profile up ON up.default_config_id = c.id
    WHERE up.user_id = p_user_id AND c.is_active = true
    ORDER BY c.version DESC LIMIT 1;

    -- 合并：全局 -> tenant -> user (使用 merge 函数)
    merged := api.merge_portkey_configs(global_template, tenant_template);
    merged := api.merge_portkey_configs(merged, user_config);

    -- 注入 metadata
    merged := jsonb_set(merged, '{metadata}', api.build_portkey_metadata(p_user_id));

    RETURN merged;
END;
$$;


ALTER FUNCTION api.get_active_portkey_config(p_tenant_id uuid, p_user_id uuid) OWNER TO geohuz;

--
-- Name: get_customer_type_pricing(uuid); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.get_customer_type_pricing(p_customer_type_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    rec RECORD;
    result jsonb := '{"prices": {}}'::jsonb;
BEGIN
    FOR rec IN
        SELECT pr.id AS provider_rate_id,
               pr.provider,
               pr.model,
               ctr.price_per_token,
               ctr.price_per_input_token,
               ctr.price_per_output_token
        FROM data.customer_type_rate ctr
        JOIN data.provider_rate pr
          ON ctr.provider_rate_id = pr.id
        WHERE ctr.customer_type_id = p_customer_type_id
    LOOP
        result := jsonb_set(
    result,
    ARRAY['prices', rec.provider || ':' || rec.model],
    jsonb_build_object(
        'price_per_token', rec.price_per_token,
        'price_per_input_token', rec.price_per_input_token,
        'price_per_output_token', rec.price_per_output_token,
        'provider_rate_id', rec.provider_rate_id,
        'currency', 'usd',
        'pricing_model', 'per_token'
    )
);
    END LOOP;

    -- 添加 customer_type_id
    result := result || jsonb_build_object('customer_type_id', p_customer_type_id);

    RETURN result;
END;
$$;


ALTER FUNCTION api.get_customer_type_pricing(p_customer_type_id uuid) OWNER TO geohuz;

--
-- Name: get_level_config_with_context(text, text, uuid, jsonb); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.get_level_config_with_context(p_config_type text, p_level_name text, p_scope_id uuid DEFAULT NULL::uuid, p_context jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    v_config JSONB;
    v_tier_name TEXT;
BEGIN
    v_tier_name := p_context->>'tier_name';
    
    RAISE NOTICE '    🔍 查询配置: type=%, level=%, scope_id=%, tier=%', 
        p_config_type, p_level_name, p_scope_id, v_tier_name;
    
    -- 🟢 明确区分两种情况：
    IF p_scope_id IS NOT NULL THEN
        -- 情况1：查询特定实体的配置（精确匹配 scope_id）
        SELECT ucs.config_value INTO v_config
        FROM data.unified_config_store ucs
        WHERE ucs.config_type = p_config_type
          AND ucs.level_name = p_level_name
          AND ucs.scope_id = p_scope_id  -- 🟢 精确匹配
          AND (ucs.effective_to IS NULL OR ucs.effective_to > NOW())
          AND (ucs.applied_tier IS NULL OR ucs.applied_tier = v_tier_name)
          AND (ucs.condition_context IS NULL OR api.evaluate_condition(ucs.condition_context, p_context))
        ORDER BY 
            CASE WHEN ucs.applied_tier = v_tier_name THEN 1 ELSE 2 END,
            ucs.version DESC
        LIMIT 1;
    ELSE
        -- 情况2：查询默认配置（用于继承），只找 scope_id IS NULL 的记录
        SELECT ucs.config_value INTO v_config
        FROM data.unified_config_store ucs
        WHERE ucs.config_type = p_config_type
          AND ucs.level_name = p_level_name
          AND ucs.scope_id IS NULL  -- 🟢 只找默认配置
          AND (ucs.effective_to IS NULL OR ucs.effective_to > NOW())
          AND (ucs.applied_tier IS NULL OR ucs.applied_tier = v_tier_name)
          AND (ucs.condition_context IS NULL OR api.evaluate_condition(ucs.condition_context, p_context))
        ORDER BY 
            CASE WHEN ucs.applied_tier = v_tier_name THEN 1 ELSE 2 END,
            ucs.version DESC
        LIMIT 1;
    END IF;
    
    RAISE NOTICE '    📦 找到配置: %', v_config;
    
    RETURN v_config;
END;
$$;


ALTER FUNCTION api.get_level_config_with_context(p_config_type text, p_level_name text, p_scope_id uuid, p_context jsonb) OWNER TO geohuz;

--
-- Name: get_portkey_template(uuid); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.get_portkey_template(p_id uuid) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    AS $$
SELECT template_json
FROM data.portkey_config_templates
WHERE id = p_id;
$$;


ALTER FUNCTION api.get_portkey_template(p_id uuid) OWNER TO geohuz;

--
-- Name: get_tier_default_config(text, text, jsonb); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.get_tier_default_config(p_config_type text, p_tier_name text, p_context jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    v_config JSONB;
BEGIN
    RAISE NOTICE '    🍰 查询套餐默认配置: type=%, tier=%', p_config_type, p_tier_name;
    
    -- 查询套餐特性映射，考虑条件和生效时间
    SELECT tfm.feature_value INTO v_config
    FROM data.tier_feature_mappings tfm
    WHERE tfm.tier_name = p_tier_name
      AND tfm.config_type = p_config_type
      AND tfm.is_active = true
      AND (tfm.effective_to IS NULL OR tfm.effective_to > NOW())
      AND (
        -- 条件匹配
        tfm.condition_expression IS NULL 
        OR api.evaluate_condition(tfm.condition_expression, p_context)
      )
    ORDER BY 
        -- 优先级：有条件匹配的 > 无条件默认的
        CASE WHEN tfm.condition_expression IS NULL THEN 2 ELSE 1 END,
        tfm.effective_from DESC
    LIMIT 1;
    
    RAISE NOTICE '    📦 套餐配置结果: %', v_config;
    RETURN v_config;
END;
$$;


ALTER FUNCTION api.get_tier_default_config(p_config_type text, p_tier_name text, p_context jsonb) OWNER TO geohuz;

--
-- Name: get_user_context(uuid); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.get_user_context(p_user_id uuid) RETURNS TABLE(user_id uuid, username text, tenant_id uuid, tenant_name text, status text, balance numeric, can_use_api boolean, virtual_keys jsonb)
    LANGUAGE sql SECURITY DEFINER
    AS $$
SELECT 
    up.user_id,
    up.username,
    up.tenant_id,
    t.name as tenant_name,
    up.status,
    COALESCE(ab.balance, 0) as balance,
    up.status IN ('active', 'free_period') as can_use_api,
    COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'virtual_key', vk.virtual_key,
                'name', vk.name,
                'rate_limits', jsonb_build_object(
                    'rpm', vk.rate_limit_rpm,
                    'tpm', vk.rate_limit_tpm
                ),
                'allowed_models', vk.allowed_models
            )
        ) FILTER (WHERE vk.id IS NOT NULL),
        '[]'::jsonb
    ) as virtual_keys
FROM data.user_profile up
LEFT JOIN data.tenant t ON up.tenant_id = t.id
LEFT JOIN data.account_balance ab ON up.user_id = ab.user_id
LEFT JOIN data.virtual_key vk ON up.user_id = vk.user_id AND vk.is_active = true
WHERE up.user_id = p_user_id
GROUP BY up.user_id, up.username, up.tenant_id, t.name, up.status, ab.balance;
$$;


ALTER FUNCTION api.get_user_context(p_user_id uuid) OWNER TO geohuz;

--
-- Name: get_virtualkey_config(text); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.get_virtualkey_config(p_virtual_key text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    vk record;
    final_config jsonb;
BEGIN
    -- 查询 virtual_key
    SELECT *
    INTO vk
    FROM data.virtual_key
    WHERE virtual_key = p_virtual_key;

    -- 404: virtual_key 不存在
    IF NOT FOUND THEN
        RAISE EXCEPTION
            USING
                ERRCODE = 'P0001',
                MESSAGE = 'API key not found',
                DETAIL  = '',
                HINT    = 'Verify the api key before calling this API.';
    END IF;

    -- 400: virtual_key 未激活
    IF vk.is_active = false THEN
        RAISE EXCEPTION
            USING
                ERRCODE = 'P0001',
                MESSAGE = 'API key is not active',
                DETAIL  = '',
                HINT    = 'Reactivate the api key to use this API.';
    END IF;

    -- 计算最终 config
    final_config := data.refresh_virtual_key_computed_config(vk.id);

    -- 400: computed_config 是空对象 {}
    IF final_config = '{}'::jsonb THEN
        RAISE EXCEPTION
            USING
                ERRCODE = 'P0001',
                MESSAGE = 'Configuration not found',
                DETAIL  = '',
                HINT    = '该 API Key 未配置, 请联系支持。';
    END IF;

    -- 写回虚拟 key 表
    UPDATE data.virtual_key
    SET
        computed_config = final_config,
        updated_at = now()
    WHERE id = vk.id;

    RETURN final_config;
END;
$$;


ALTER FUNCTION api.get_virtualkey_config(p_virtual_key text) OWNER TO geohuz;

--
-- Name: get_virtualkey_pricing(text); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.get_virtualkey_pricing(p_virtual_key text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    vk data.virtual_key%ROWTYPE;
    user_profile data.user_profile%ROWTYPE;
    ct_id uuid;
    pricing jsonb := '{}';
    rec RECORD;
BEGIN
    -- 1️⃣ 查 virtual_key
    SELECT * INTO vk
    FROM data.virtual_key
    WHERE virtual_key = trim(p_virtual_key);

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Virtual key not found';
    END IF;

    IF vk.is_active = false THEN
        RAISE EXCEPTION 'Virtual key is inactive';
    END IF;

    -- 2️⃣ 查 user_profile
    SELECT * INTO user_profile
    FROM data.user_profile
    WHERE user_id = vk.user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'User profile not found';
    END IF;

    -- 3️⃣ 决定 customer_type_id (tenant 优先)
    IF user_profile.tenant_id IS NOT NULL THEN
        SELECT customer_type_id INTO ct_id
        FROM data.tenant
        WHERE id = user_profile.tenant_id;
    ELSE
        ct_id := user_profile.customer_type_id;
    END IF;

    IF ct_id IS NULL THEN
        RAISE EXCEPTION 'Customer type not found for user';
    END IF;

    -- 4️⃣ 查询价格表并构建 JSON
    FOR rec IN
        SELECT
            p.provider,
            p.model,
            p.id AS provider_rate_id,
            ctr.price_per_token,
            ctr.price_per_input_token,
            ctr.price_per_output_token,
            COALESCE(p.currency,'USD') AS currency,
            COALESCE(p.pricing_model,'per_token') AS pricing_model
        FROM data.customer_type_rate ctr
        JOIN data.provider_rate p
            ON p.id = ctr.provider_rate_id
        WHERE ctr.customer_type_id = ct_id
    LOOP
        pricing := pricing || jsonb_build_object(
            rec.provider || ':' || rec.model,
            jsonb_build_object(
                'provider_rate_id', rec.provider_rate_id,
                'price_per_token', rec.price_per_token,
                'price_per_input_token', rec.price_per_input_token,
                'price_per_output_token', rec.price_per_output_token,
                'currency', rec.currency,
                'pricing_model', rec.pricing_model
            )
        );
    END LOOP;

    -- 5️⃣ 返回完整 JSON
    RETURN jsonb_build_object(
        'virtual_key', p_virtual_key,
        'customer_type_id', ct_id,
        'prices', pricing
    );
END;
$$;


ALTER FUNCTION api.get_virtualkey_pricing(p_virtual_key text) OWNER TO geohuz;

--
-- Name: initialize_system_config_types(); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.initialize_system_config_types() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- 清理现有数据（谨慎使用）
    TRUNCATE TABLE data.config_types CASCADE;
    
 -- 插入配置类型及默认值
INSERT INTO data.config_types (type_name, display_name, value_schema, default_value, merge_strategy, description, is_system_type, supports_tier_entitlements) VALUES 
-- 🚀 网关路由配置
('gateway_routing', '网关路由', 
 '{"type": "object", "properties": {"timeout": {"type": "number"}, "retry_count": {"type": "number"}, "provider": {"type": "string"}}}',
 '{"timeout": 30, "retry_count": 3}',
 'deep_merge', 
 'API网关路由策略，控制超时、重试等', 
 true, false),

-- 📊 速率限制  
('rate_limits', '速率限制',
 '{"type": "object", "properties": {"rpm": {"type": "number"}, "tpm": {"type": "number"}, "daily_limit": {"type": "number"}}}',
 '{"rpm": 100, "tpm": 10000}',
 'override',
 'API调用频率限制，包括每分钟请求数和token数',
 true, true),

-- 🧠 模型权限
('model_access', '模型权限',
 '{"type": "object", "properties": {"allowed_models": {"type": "array"}, "blocked_models": {"type": "array"}}}',
 '{"allowed_models": ["gpt-3.5-turbo"]}',
 'array_append',
 '可访问的AI模型列表，支持模型级权限控制',
 true, true),

-- 💰 计费规则
('billing_rules', '计费规则', 
 '{"type": "object", "properties": {"price_per_token": {"type": "number"}, "currency": {"type": "string"}, "free_quota": {"type": "number"}}}',
 '{"price_per_token": 0.00002, "currency": "USD", "free_quota": 1000}',
 'override',
 '计费策略和价格配置',
 true, true),

-- 🔒 安全策略
('security_policy', '安全策略',
 '{"type": "object", "properties": {"require_2fa": {"type": "boolean"}, "ip_whitelist": {"type": "array"}, "audit_logging": {"type": "boolean"}}}',
 '{"require_2fa": false, "audit_logging": true}',
 'deep_merge',
 '安全控制策略，包括双因子认证、IP白名单等',
 true, false),

-- 🛡️ 内容过滤
('content_filters', '内容过滤',
 '{"type": "object", "properties": {"moderation_enabled": {"type": "boolean"}, "custom_filters": {"type": "array"}}}',
 '{"moderation_enabled": true}',
 'deep_merge',
 '内容安全过滤策略，支持自定义过滤规则',
 true, false),

-- 💾 缓存策略
('cache_strategy', '缓存策略',
 '{"type": "object", "properties": {"enabled": {"type": "boolean"}, "ttl": {"type": "number"}, "strategy": {"type": "string"}}}',
 '{"enabled": false, "ttl": 3600}',
 'override',
 '响应缓存策略，控制缓存生效时间和策略',
 true, true),

-- 📈 监控告警
('monitoring_alert', '监控告警',
 '{"type": "object", "properties": {"alert_threshold": {"type": "number"}, "notify_channels": {"type": "array"}, "enabled": {"type": "boolean"}}}',
 '{"alert_threshold": 0.8, "enabled": true, "notify_channels": ["email"]}',
 'override',
 '系统监控和告警配置',
 true, false);
    
    RAISE NOTICE '✅ 系统配置类型初始化完成';
END;
$$;


ALTER FUNCTION api.initialize_system_config_types() OWNER TO geohuz;

--
-- Name: login(text, text); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.login(email text, pass text) RETURNS auth.jwt_token
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'api', 'data', 'public'
    AS $$
declare
  rec record;
  result auth.jwt_token;
begin
  -- check email and password
  select * INTO rec FROM auth.user_role(email, pass);
  if rec.role is null then
    raise invalid_password using message = 'invalid user or password';
  end if;
  
  SELECT sign(
  
      json_build_object(
        'role', rec.role,
        'email', email,
        'userid', rec.userid,
        'exp', extract(epoch from now())::integer + 60*60 
      )
    , 
    current_setting('app.jwt_secret')
    ) INTO result;
    
  return result;
end;
$$;


ALTER FUNCTION api.login(email text, pass text) OWNER TO geohuz;

--
-- Name: merge_portkey_configs(jsonb, jsonb); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.merge_portkey_configs(p_base_json jsonb, p_override_json jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    merged jsonb := p_base_json;
    key text;
BEGIN
    IF p_override_json IS NULL THEN
        RETURN p_base_json;
    END IF;

    FOR key IN SELECT jsonb_object_keys(p_override_json) LOOP
        IF jsonb_typeof(p_override_json -> key) = 'array' THEN
            -- 数组：替换
            merged := jsonb_set(merged, ARRAY[key], p_override_json -> key);
        ELSIF jsonb_typeof(p_override_json -> key) = 'object' THEN
            -- 对象：递归合并
            merged := jsonb_set(merged, ARRAY[key], api.merge_portkey_configs(merged -> key, p_override_json -> key));
        ELSE
            -- 标量：覆盖
            merged := jsonb_set(merged, ARRAY[key], p_override_json -> key);
        END IF;
    END LOOP;

    RETURN merged;
END;
$$;


ALTER FUNCTION api.merge_portkey_configs(p_base_json jsonb, p_override_json jsonb) OWNER TO geohuz;

--
-- Name: record_usage(uuid, text, text, integer, integer, numeric, text); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.record_usage(p_user_id uuid, p_provider text, p_model text, p_input_tokens integer, p_output_tokens integer, p_cost numeric, p_prompt_hash text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    new_usage_id uuid;
    total_tokens integer := p_input_tokens + p_output_tokens;
    current_balance numeric;
    new_balance numeric;
BEGIN
    -- 使用 FOR UPDATE 锁住余额行
    SELECT balance INTO current_balance
    FROM data.account_balance
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF current_balance IS NULL THEN
        RAISE EXCEPTION 'Insufficient balance';
    END IF;

    -- 🆕 允许余额为负，完成当前请求
    new_balance := current_balance - p_cost;

    -- 1️⃣ 写 usage_logs
    INSERT INTO data.usage_log(
        user_id,
        provider,
        model,
        input_tokens,
        output_tokens,
        tokens_used,
        cost,
        prompt_hash
    )
    VALUES (
        p_user_id,
        p_provider,
        p_model,
        p_input_tokens,
        p_output_tokens,
        total_tokens,
        p_cost,
        p_prompt_hash
    )
    RETURNING id INTO new_usage_id;

    -- 2️⃣ 扣余额（允许为负）
    UPDATE data.account_balance
    SET balance = new_balance
    WHERE user_id = p_user_id;

    -- 3️⃣ 写账务事件
    INSERT INTO data.billing_event(
        user_id,
        event_type,
        amount,
        balance_after,
        description
    )
    VALUES (
        p_user_id,
        'debit',
        p_cost,
        new_balance,
        'AI usage'
    );

    -- 🆕 4️⃣ 如果余额为负，立即标记为 overdue 状态
    IF new_balance <= 0 THEN
        PERFORM internal.change_user_status(p_user_id, 'overdue');
    END IF;

    RETURN new_usage_id;
END;
$$;


ALTER FUNCTION api.record_usage(p_user_id uuid, p_provider text, p_model text, p_input_tokens integer, p_output_tokens integer, p_cost numeric, p_prompt_hash text) OWNER TO geohuz;

--
-- Name: register_user(text, text, text, text, uuid); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.register_user(p_email text, p_username text, p_password text, p_role text DEFAULT 'norm_user'::text, p_tenant_id uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'api', 'data', 'public'
    AS $$
DECLARE
    new_user_id uuid;
BEGIN
    -- 1️⃣ 检查 role 是否有效
    IF p_role NOT IN ('norm_user', 'tenant_admin') THEN
        RAISE EXCEPTION 'Invalid role. Only norm_user or tenant_admin allowed.';
    END IF;

    -- 2️⃣ 检查 email 是否已存在
    IF EXISTS (SELECT 1 FROM auth.login WHERE email = p_email) THEN
        RAISE EXCEPTION 'Email % already exists.', p_email;
    END IF;

    -- 3️⃣ 检查 username 是否已存在
    IF EXISTS (SELECT 1 FROM data.user_profile WHERE username = p_username) THEN
        RAISE EXCEPTION 'Username % already exists.', p_username;
    END IF;

    -- 4️⃣ tenant_admin 必须提供 tenant_id
    IF p_role = 'tenant_admin' AND p_tenant_id IS NULL THEN
        RAISE EXCEPTION 'tenant_id must be provided for tenant_admin';
    END IF;

    -- 5️⃣ 插入 auth.login（只保存认证信息）
    INSERT INTO auth.login (email, hashed_password, role)
    VALUES (
        p_email,
        p_password,  -- bcrypt
        p_role
    )
    RETURNING id INTO new_user_id;

    -- 6️⃣ 插入 data.user_profile（保存额外信息，包括 tenant_id）
    INSERT INTO data.user_profile(user_id, username, tenant_id, status)
    VALUES (new_user_id, p_username, p_tenant_id, 'pending');

    -- 7️⃣ 调用 complete_registration 完成初始化
    PERFORM internal.complete_user_registration(new_user_id);
	
    -- 7️⃣ 返回新用户 id
    RETURN new_user_id;
END;
$$;


ALTER FUNCTION api.register_user(p_email text, p_username text, p_password text, p_role text, p_tenant_id uuid) OWNER TO geohuz;

--
-- Name: resolve_dynamic_config(text, text, uuid, jsonb); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.resolve_dynamic_config(p_config_type text, p_target_level text, p_target_scope_id uuid, p_context jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_result JSONB;
    v_inheritance_path TEXT[];
    v_current_config JSONB;
    v_i INTEGER;
    v_found_any_config BOOLEAN := false;
    v_current_level TEXT;
    v_tier_config JSONB;
    v_has_specific_config BOOLEAN := false;
BEGIN
 
    -- 🟢 先获取套餐配置
IF p_context ? 'tier_name' THEN
    -- 🟢 新增检查
    IF EXISTS (
        SELECT 1 FROM data.config_types 
        WHERE type_name = p_config_type 
        AND supports_tier_entitlements = true
    ) THEN
        v_tier_config := api.get_tier_default_config(p_config_type, p_context->>'tier_name', p_context);
        RAISE NOTICE '🎯 套餐权益: %', v_tier_config;
    ELSE
        v_tier_config := NULL;
        RAISE NOTICE '⚠️ 配置类型"%s"不支持套餐权益', p_config_type;
    END IF;
ELSE
    v_tier_config := NULL;
END IF;

    -- 1. 构建继承路径
    RAISE NOTICE '📋 步骤1: 构建继承路径...';
    WITH RECURSIVE inheritance_path AS (
        SELECT 
            level_name,
            parent_level,
            inherit_priority,
            1 as depth,
            level_name as start_level
        FROM data.config_levels 
        WHERE level_name = p_target_level
        
        UNION ALL
        
        SELECT 
            parent.level_name,
            parent.parent_level,
            parent.inherit_priority,
            ip.depth + 1,
            ip.start_level
        FROM data.config_levels parent
        INNER JOIN inheritance_path ip ON parent.level_name = ip.parent_level
        WHERE ip.parent_level IS NOT NULL
          AND ip.depth < 10     -- 深度限制              -- 继承完整性保障
          AND EXISTS (          -- 确保继承规则存在且有效
            SELECT 1 FROM data.inheritance_rules ir
            WHERE ir.parent_level = parent.level_name
              AND ir.child_level = ip.level_name
              AND ir.config_type = p_config_type
              AND ir.is_inheritance_enabled = true
              AND ir.is_active = true
              AND (ir.effective_to IS NULL OR ir.effective_to > NOW())
          )
    )
    SELECT ARRAY_AGG(ip.level_name ORDER BY ip.inherit_priority ASC, ip.depth ASC) 
    INTO v_inheritance_path
    FROM inheritance_path ip;
    
    IF v_inheritance_path IS NULL THEN
        v_inheritance_path := ARRAY[p_target_level];
    END IF;
    
    RAISE NOTICE '✅ 继承路径: %', v_inheritance_path;

    -- 2. 按路径顺序合并配置
    RAISE NOTICE '🔄 步骤2: 合并配置...';
    v_result := NULL;
    v_found_any_config := false;
    v_has_specific_config := false;
    
    FOR v_i IN 1..array_length(v_inheritance_path, 1) LOOP
        v_current_level := v_inheritance_path[v_i];
        RAISE NOTICE '  处理层级 %/%: %', v_i, array_length(v_inheritance_path, 1), v_current_level;
        
        v_current_config := api.get_level_config_with_context(
            p_config_type,
            v_current_level,
            CASE 
                WHEN v_current_level = p_target_level THEN p_target_scope_id
                ELSE NULL
            END,
            p_context
        );
        
        RAISE NOTICE '  配置结果: %', v_current_config;
        
        IF v_current_config IS NOT NULL THEN
            v_found_any_config := true;
            
            IF v_current_level = p_target_level AND p_target_scope_id IS NOT NULL THEN
                v_has_specific_config := true;
                RAISE NOTICE '  🎯 找到特定配置，标记为已找到特定配置';
            END IF;
            
            IF v_result IS NULL THEN
                v_result := v_current_config;
                RAISE NOTICE '  初始配置: %', v_result;
            ELSE
                v_result := api.dynamic_merge_config(
                    v_result, 
                    v_current_config, 
                    p_config_type,
                    v_current_level,
                    p_context
                );
                RAISE NOTICE '  合并后结果: %', v_result;
            END IF;
        END IF;
    END LOOP;

    RAISE NOTICE '📊 合并完成结果: %, 找到配置: %, 有特定配置: %', v_result, v_found_any_config, v_has_specific_config;
    
    -- 🟢 步骤3: 简化的套餐应用逻辑
    IF v_tier_config IS NOT NULL THEN
        -- 情况1: 没有找到任何配置 → 直接使用套餐
        IF v_result IS NULL THEN
            RAISE NOTICE '🍰 情况1: 无任何配置，直接使用套餐';
            v_result := v_tier_config;
        
        -- 🟢 情况2: 有配置但没有特定配置 → 强制使用套餐配置
        ELSIF NOT v_has_specific_config THEN
            RAISE NOTICE '🍰 情况2: 有默认配置但无特定配置，强制使用套餐配置';
            v_result := v_tier_config;  -- 🟢 直接使用套餐，忽略默认配置
            RAISE NOTICE '  🎯 套餐配置覆盖默认配置: %', v_result;
        
        -- 情况3: 有特定配置 → 保持现有逻辑（特定配置优先）
        ELSE
            RAISE NOTICE '🍰 情况3: 有特定配置，保持现有结果（特定配置优先）';
            -- 不修改 v_result
        END IF;
    END IF;
    
    -- 4. 如果还是没有配置，使用全局默认值
    IF v_result IS NULL THEN
        RAISE NOTICE '🌍 步骤4: 使用全局默认值';
        SELECT default_value INTO v_result
        FROM data.config_types
        WHERE type_name = p_config_type;
        RAISE NOTICE '  全局默认值: %', v_result;
    END IF;
    
    RAISE NOTICE '🎯 最终结果: %', v_result;
    RETURN v_result;
END;
$$;


ALTER FUNCTION api.resolve_dynamic_config(p_config_type text, p_target_level text, p_target_scope_id uuid, p_context jsonb) OWNER TO geohuz;

--
-- Name: rotate_virtual_key(text, text); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.rotate_virtual_key(p_old_virtual_key text, p_reason text DEFAULT 'security_rotation'::text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_key_record data.virtual_key%ROWTYPE;
    v_new_virtual_key TEXT;
    v_new_virtual_key_id UUID;
BEGIN
    -- 获取原密钥信息
    SELECT * INTO v_key_record 
    FROM data.virtual_key 
    WHERE virtual_key = p_old_virtual_key AND is_active = true
    FOR UPDATE;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Virtual key not found or inactive';
    END IF;
    
    -- 生成新密钥（保持相同配置）
    INSERT INTO data.virtual_key (
        user_id, name, description, 
        rate_limit_rpm, rate_limit_tpm, allowed_models,
        key_type_id, key_prefix, is_active
    ) VALUES (
        v_key_record.user_id,
        v_key_record.name || ' (rotated)',
        v_key_record.description,
        v_key_record.rate_limit_rpm,
        v_key_record.rate_limit_tpm,
        v_key_record.allowed_models,
        v_key_record.key_type_id,
        v_key_record.key_prefix,
        true
    )
    RETURNING virtual_key, id INTO v_new_virtual_key, v_new_virtual_key_id;
    
    -- 停用旧密钥
    UPDATE data.virtual_key 
    SET is_active = false, 
        updated_at = NOW(),
        description = COALESCE(description, '') || ' - Rotated: ' || p_reason
    WHERE virtual_key = p_old_virtual_key;
    
    -- 🆕 发送旧密钥停用通知
    PERFORM pg_notify('virtual_key_update', 
        jsonb_build_object(
            'action', 'deactivate',
            'virtual_key_id', v_key_record.id,
            'user_id', v_key_record.user_id,
            'virtual_key', p_old_virtual_key,
            'reason', 'rotated: ' || p_reason,
            'rotation_new_key', v_new_virtual_key,  -- 🟢 关联新密钥
            'timestamp', extract(epoch from now())::text
        )::text
    );
    
    -- 🆕 发送新密钥创建通知
    PERFORM pg_notify('virtual_key_update', 
        jsonb_build_object(
            'action', 'create',
            'virtual_key_id', v_new_virtual_key_id,
            'user_id', v_key_record.user_id,
            'virtual_key', v_new_virtual_key,
            'rate_limits', jsonb_build_object(
                'rpm', v_key_record.rate_limit_rpm,
                'tpm', v_key_record.rate_limit_tpm
            ),
            'allowed_models', v_key_record.allowed_models,
            'key_type_id', v_key_record.key_type_id,
            'key_prefix', v_key_record.key_prefix,
            'rotation_old_key', p_old_virtual_key,  -- 🟢 关联旧密钥
            'reason', p_reason,
            'timestamp', extract(epoch from now())::text
        )::text
    );
    
    RETURN v_new_virtual_key;
END;
$$;


ALTER FUNCTION api.rotate_virtual_key(p_old_virtual_key text, p_reason text) OWNER TO geohuz;

--
-- Name: setup_test_config(numeric, numeric, numeric); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.setup_test_config(p_overdue_threshold numeric DEFAULT 5, p_free_period_days numeric DEFAULT 30, p_min_topup_amount numeric DEFAULT 10) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  -- 插入或更新测试配置
  INSERT INTO internal.system_config (config_key, config_value, data_type, description)
  VALUES 
    ('overdue_recovery_threshold', p_overdue_threshold::text, 'numeric', '欠费恢复阈值(元)'),
    ('free_period_days', p_free_period_days::text, 'numeric', '免费试用期天数'),
    ('min_topup_amount', p_min_topup_amount::text, 'numeric', '最低充值金额')
  ON CONFLICT (config_key) 
  DO UPDATE SET 
    config_value = EXCLUDED.config_value,
    updated_at = NOW();
END;
$$;


ALTER FUNCTION api.setup_test_config(p_overdue_threshold numeric, p_free_period_days numeric, p_min_topup_amount numeric) OWNER TO geohuz;

--
-- Name: setup_test_data(jsonb, jsonb, jsonb, jsonb); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.setup_test_data(p_tenant_data jsonb, p_tenant_admin_data jsonb, p_normal_user_data jsonb, p_virtual_key_types jsonb DEFAULT '[]'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'api', 'data', 'public'
    AS $$
DECLARE
    tenant_id uuid;
    tenant_admin_id uuid;
    normal_user_id uuid;
BEGIN
    -- 1. 创建租户
    INSERT INTO data.tenant (name, contact, notes)
    VALUES (
        p_tenant_data->>'name',
        p_tenant_data->>'contact', 
        p_tenant_data->>'notes'
    )
    RETURNING id INTO tenant_id;

    -- 2. 使用 register_user 创建租户管理员
    tenant_admin_id := api.register_user(
        p_email := p_tenant_admin_data->>'email',
        p_username := p_tenant_admin_data->>'username', 
        p_password := p_tenant_admin_data->>'password',
        p_role := 'tenant_admin',
        p_tenant_id := tenant_id
    );

    -- 3. 使用 register_user 创建普通用户
    normal_user_id := api.register_user(
        p_email := p_normal_user_data->>'email',
        p_username := p_normal_user_data->>'username',
        p_password := p_normal_user_data->>'password',
        p_role := 'norm_user',
        p_tenant_id := tenant_id
    );

    -- 4. 插入虚拟密钥类型（提供 tenant_id）
    IF jsonb_array_length(p_virtual_key_types) > 0 THEN
        INSERT INTO data.virtual_key_types (
            type_name, description, rate_limit_rpm, rate_limit_tpm, allowed_models, tenant_id
        )
        SELECT 
            elem->>'type_name',
            elem->>'description',
            (elem->>'rate_limit_rpm')::integer,
            (elem->>'rate_limit_tpm')::integer,
            ARRAY(
                SELECT jsonb_array_elements_text(elem->'allowed_models')
            )::text[],
            tenant_id  -- 提供 tenant_id
        FROM jsonb_array_elements(p_virtual_key_types) AS elem;
    END IF;

    -- 5. 返回创建的所有ID
    RETURN jsonb_build_object(
        'tenant_id', tenant_id,
        'tenant_admin_id', tenant_admin_id, 
        'normal_user_id', normal_user_id
    );
END;
$$;


ALTER FUNCTION api.setup_test_data(p_tenant_data jsonb, p_tenant_admin_data jsonb, p_normal_user_data jsonb, p_virtual_key_types jsonb) OWNER TO geohuz;

--
-- Name: test_advanced_config_system(); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.test_advanced_config_system() RETURNS TABLE(test_category text, test_scenario text, config_type_name text, target_level text, expected_value jsonb, actual_value jsonb, status text)
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_tenant_id UUID := gen_random_uuid();
    v_project_id UUID := gen_random_uuid();
    v_app_id UUID := gen_random_uuid();
    v_virtual_key_id UUID := gen_random_uuid();
    v_new_virtual_key_id UUID := gen_random_uuid();  -- 🟢 专门用于套餐测试的新密钥
    
    v_result JSONB;
BEGIN
    -- 清理测试数据
    PERFORM api.cleanup_test_data();
    
    -- 初始化测试层级（确保继承关系正确）
    INSERT INTO data.config_levels (level_name, display_name, parent_level, inherit_priority) VALUES 
    ('test_platform', '测试平台', NULL, 1),
    ('test_tenant', '测试租户', 'test_platform', 2),
    ('test_project', '测试项目', 'test_tenant', 3),
    ('test_app', '测试应用', 'test_project', 4),
    ('test_virtual_key', '测试密钥', 'test_app', 5);
    
    -- 初始化配置类型
    INSERT INTO data.config_types (type_name, display_name, value_schema, default_value, merge_strategy, description) VALUES 
    ('gateway_routing', '路由配置', '{"type":"object"}', '{"timeout": 30}', 'deep_merge', '网关路由配置'),
    ('rate_limits', '速率限制', '{"type":"object"}', '{"rpm": 100}', 'override', 'API限制配置'),
    ('model_access', '模型权限', '{"type":"object"}', '{"allowed_models": ["gpt-3.5-turbo"]}', 'array_append', '模型访问控制');
    
    -- 初始化继承规则（确保所有层级间都有继承关系）
    INSERT INTO data.inheritance_rules (parent_level, child_level, config_type, is_inheritance_enabled, custom_merge_strategy) VALUES 
    ('test_platform', 'test_tenant', 'gateway_routing', true, 'deep_merge'),
    ('test_platform', 'test_tenant', 'rate_limits', true, 'override'),
    ('test_platform', 'test_tenant', 'model_access', true, 'array_append'),
    ('test_tenant', 'test_project', 'gateway_routing', true, 'deep_merge'),
    ('test_tenant', 'test_project', 'rate_limits', true, 'override'),
    ('test_tenant', 'test_project', 'model_access', true, 'array_append'),
    ('test_project', 'test_app', 'gateway_routing', true, 'deep_merge'),
    ('test_project', 'test_app', 'rate_limits', true, 'override'),
    ('test_project', 'test_app', 'model_access', true, 'array_append'),
    ('test_app', 'test_virtual_key', 'gateway_routing', true, 'deep_merge'),
    ('test_app', 'test_virtual_key', 'rate_limits', true, 'override'),
    ('test_app', 'test_virtual_key', 'model_access', true, 'array_append');
    
    RAISE NOTICE '🎯 开始高级配置系统测试...';
    
    -- 🧪 测试类别 1: 路由配置测试
    test_category := '路由配置';
    
    -- 测试场景 1.1: 基础路由继承
    test_scenario := '基础路由配置继承';
    config_type_name := 'gateway_routing';
    target_level := 'test_virtual_key';
    
    -- 设置测试数据：确保每个层级都有默认配置
    INSERT INTO data.unified_config_store (config_type, level_name, scope_id, config_value) VALUES
    ('gateway_routing', 'test_platform', NULL, '{"timeout": 30, "retry_count": 3}'),
    ('gateway_routing', 'test_tenant', NULL, '{"timeout": 60}'),  -- 默认配置
    ('gateway_routing', 'test_virtual_key', v_virtual_key_id, '{"provider": "openai"}');  -- 特定配置
    
    expected_value := '{"timeout": 60, "retry_count": 3, "provider": "openai"}';
    v_result := api.resolve_dynamic_config(config_type_name, target_level, v_virtual_key_id, '{}');
    actual_value := v_result;
    status := CASE WHEN v_result @> expected_value THEN 'PASS' ELSE 'FAIL' END;
    RETURN NEXT;
    
    -- 🧪 测试类别 2: 速率限制测试
    test_category := '速率限制';
    
    -- 测试场景 2.1: 速率限制覆盖（这个应该通过）
    test_scenario := '速率限制完全覆盖';
    config_type_name := 'rate_limits';
    
    INSERT INTO data.unified_config_store (config_type, level_name, scope_id, config_value) VALUES
    ('rate_limits', 'test_platform', NULL, '{"rpm": 100, "tpm": 10000}'),
    ('rate_limits', 'test_tenant', NULL, '{"rpm": 1000, "tpm": 100000}'),
    ('rate_limits', 'test_virtual_key', v_virtual_key_id, '{"rpm": 500}');
    
    expected_value := '{"rpm": 500}';
    v_result := api.resolve_dynamic_config(config_type_name, target_level, v_virtual_key_id, '{}');
    actual_value := v_result;
    status := CASE WHEN (v_result->>'rpm')::INTEGER = 500 THEN 'PASS' ELSE 'FAIL' END;
    RETURN NEXT;
    
    -- 测试场景 2.2: 套餐默认速率（关键修复）
    test_scenario := '套餐默认速率限制';
    config_type_name := 'rate_limits';
    
    -- 设置套餐特性
    INSERT INTO data.tier_definitions (tier_name, display_name) VALUES 
    ('test_premium', '测试高级版');
    
    INSERT INTO data.tier_feature_mappings (tier_name, config_type, feature_value) VALUES
    ('test_premium', 'rate_limits', '{"rpm": 5000, "tpm": 500000}');
    
    -- 🟢 关键修复：使用全新的测试环境，确保没有任何配置存在
    -- 不插入任何 rate_limits 配置数据，让系统只能回退到套餐配置
    
    -- 测试新密钥使用套餐默认值（确保没有任何配置）
    v_result := api.resolve_dynamic_config(
        config_type_name, 
        'test_virtual_key', 
        v_new_virtual_key_id,  -- 🟢 使用全新的密钥ID，确保没有配置
        '{"tier_name": "test_premium"}'
    );
    
    expected_value := '{"rpm": 5000, "tpm": 500000}';
    actual_value := v_result;
    status := CASE 
        WHEN v_result @> '{"rpm": 5000}' AND v_result @> '{"tpm": 500000}' THEN 'PASS' 
        ELSE 'FAIL' 
    END;
    RETURN NEXT;
    
    -- 🧪 测试类别 3: 模型权限测试（这个已经通过）
    test_category := '模型权限';
    
    -- 测试场景 3.1: 模型权限数组合并
    test_scenario := '模型权限数组合并';
    config_type_name := 'model_access';
    
    INSERT INTO data.unified_config_store (config_type, level_name, scope_id, config_value) VALUES
    ('model_access', 'test_platform', NULL, '{"allowed_models": ["gpt-3.5-turbo"]}'),
    ('model_access', 'test_tenant', NULL, '{"allowed_models": ["gpt-4"]}'),
    ('model_access', 'test_project', NULL, '{"allowed_models": ["claude-2"]}'),
    ('model_access', 'test_virtual_key', v_virtual_key_id, '{"allowed_models": ["qwen-turbo"]}');
    
    v_result := api.resolve_dynamic_config(config_type_name, target_level, v_virtual_key_id, '{}');
    actual_value := v_result->'allowed_models';
    
    -- 检查是否包含所有模型（array_append 应该合并所有数组）
    status := CASE 
        WHEN v_result ? 'allowed_models' AND 
             jsonb_array_length(v_result->'allowed_models') >= 4 THEN 'PASS' 
        ELSE 'FAIL' 
    END;
    RETURN NEXT;
    
    RAISE NOTICE '✅ 高级配置系统测试完成！';
    
    -- 清理测试数据
    PERFORM api.cleanup_test_data();
    
END;
$$;


ALTER FUNCTION api.test_advanced_config_system() OWNER TO geohuz;

--
-- Name: test_complete_config_system(); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.test_complete_config_system() RETURNS TABLE(test_category text, test_scenario text, config_type_name text, expected_value jsonb, actual_value jsonb, status text)
    LANGUAGE plpgsql
    AS $$
DECLARE
    -- 测试数据ID
    v_platform_id TEXT := 'test-platform';
    v_org_id UUID := gen_random_uuid();
    v_project_id UUID := gen_random_uuid();
    v_env_id UUID := gen_random_uuid();
    v_virtual_key_id UUID := gen_random_uuid();
    v_new_virtual_key_id UUID := gen_random_uuid();
    
    v_result JSONB;
BEGIN
    -- 清理测试数据 - 更彻底的清理
    PERFORM api.cleanup_test_data();
    
    -- 🟢 先删除可能存在的测试配置类型
    DELETE FROM data.config_types WHERE type_name LIKE 'test_%';
    DELETE FROM data.config_levels WHERE level_name LIKE 'test_%';
    DELETE FROM data.tier_definitions WHERE tier_name LIKE 'test_%';
    
    -- 🟢 初始化自定义层级
    INSERT INTO data.config_levels (level_name, display_name, parent_level, inherit_priority) VALUES 
    ('test_platform_2', '测试平台', NULL, 1),
    ('test_org_2', '测试组织', 'test_platform_2', 2),
    ('test_project_2', '测试项目', 'test_org_2', 3),
    ('test_env_2', '测试环境', 'test_project_2', 4),
    ('test_virtual_key_2', '测试密钥', 'test_env_2', 5);
    
    -- 🟢 使用唯一的配置类型名称
    INSERT INTO data.config_types (type_name, display_name, value_schema, default_value, merge_strategy, description, supports_tier_entitlements) VALUES 
    ('test_rate_limits_2', '测试速率限制', '{"type":"object"}', '{"rpm": 100}', 'override', '测试速率限制', true),
    ('test_model_access_2', '测试模型权限', '{"type":"object"}', '{"allowed_models": ["gpt-3.5"]}', 'array_append', '测试模型权限', true),
    ('test_monitoring_2', '测试监控告警', '{"type":"object"}', '{"enabled": false}', 'override', '测试监控告警', false);
    
    -- 🟢 初始化继承规则
    INSERT INTO data.inheritance_rules (parent_level, child_level, config_type, is_inheritance_enabled, custom_merge_strategy) 
    SELECT parent, child, config_type, true, 'override'
    FROM (VALUES 
        ('test_platform_2', 'test_org_2'),
        ('test_org_2', 'test_project_2'),
        ('test_project_2', 'test_env_2'),
        ('test_env_2', 'test_virtual_key_2')
    ) AS levels(parent, child)
    CROSS JOIN (VALUES ('test_rate_limits_2'), ('test_model_access_2'), ('test_monitoring_2')) AS configs(config_type);
    
    -- 🟢 初始化套餐系统
    INSERT INTO data.tier_definitions (tier_name, display_name) VALUES 
    ('test_basic_2', '测试基础版'),
    ('test_pro_2', '测试专业版');
    
    -- 🟢 初始化套餐特性
    INSERT INTO data.tier_feature_mappings (tier_name, config_type, feature_value, condition_expression) VALUES 
    -- 基础版套餐
    ('test_basic_2', 'test_rate_limits_2', '{"rpm": 1000}', NULL),
    ('test_basic_2', 'test_model_access_2', '{"allowed_models": ["gpt-4"]}', NULL),
    
    -- 专业版套餐
    ('test_pro_2', 'test_rate_limits_2', '{"rpm": 5000}', NULL),
    ('test_pro_2', 'test_rate_limits_2', '{"rpm": 10000}', '{"field": "region", "operator": "in", "value": ["beijing", "shanghai"]}'),
    ('test_pro_2', 'test_model_access_2', '{"allowed_models": ["claude-2"]}', NULL),
    ('test_pro_2', 'test_model_access_2', '{"allowed_models": ["qwen-turbo"]}', '{"field": "user_type", "operator": "equals", "value": "vip"}');
    
    RAISE NOTICE '🎯 开始完整配置系统测试...';
    
    -- 🧪 测试类别 1: 基础功能测试
    test_category := '基础功能';
    
    -- 测试场景 1.1: 默认配置继承
    test_scenario := '默认配置继承';
    config_type_name := 'test_rate_limits_2';
    
    INSERT INTO data.unified_config_store (config_type, level_name, scope_id, config_value) VALUES
    ('test_rate_limits_2', 'test_platform_2', NULL, '{"rpm": 500}'),
    ('test_rate_limits_2', 'test_org_2', NULL, '{"rpm": 1000}');
    
    expected_value := '{"rpm": 1000}';
    v_result := api.resolve_dynamic_config(config_type_name, 'test_virtual_key_2', v_virtual_key_id, '{}');
    actual_value := v_result;
    status := CASE WHEN (v_result->>'rpm')::INTEGER = 1000 THEN 'PASS' ELSE 'FAIL' END;
    RETURN NEXT;
    
    -- 🧪 测试类别 2: 套餐功能测试
    test_category := '套餐功能';
    
    -- 测试场景 2.1: 基础套餐应用
    test_scenario := '基础套餐应用';
    expected_value := '{"rpm": 1000}';
    v_result := api.resolve_dynamic_config('test_rate_limits_2', 'test_virtual_key_2', v_new_virtual_key_id, '{"tier_name": "test_basic_2"}');
    actual_value := v_result;
    status := CASE WHEN (v_result->>'rpm')::INTEGER = 1000 THEN 'PASS' ELSE 'FAIL' END;
    RETURN NEXT;
    
    -- 测试场景 2.2: 专业套餐无条件默认
    test_scenario := '专业套餐无条件默认';
    expected_value := '{"rpm": 5000}';
    v_result := api.resolve_dynamic_config('test_rate_limits_2', 'test_virtual_key_2', v_new_virtual_key_id, '{"tier_name": "test_pro_2"}');
    actual_value := v_result;
    status := CASE WHEN (v_result->>'rpm')::INTEGER = 5000 THEN 'PASS' ELSE 'FAIL' END;
    RETURN NEXT;
    
    -- 测试场景 2.3: 专业套餐条件配置
    test_scenario := '专业套餐条件配置';
    expected_value := '{"rpm": 10000}';
    v_result := api.resolve_dynamic_config('test_rate_limits_2', 'test_virtual_key_2', v_new_virtual_key_id, '{"tier_name": "test_pro_2", "region": "beijing"}');
    actual_value := v_result;
    status := CASE WHEN (v_result->>'rpm')::INTEGER = 10000 THEN 'PASS' ELSE 'FAIL' END;
    RETURN NEXT;
    
    -- 测试场景 2.4: 模型权限合并
    test_scenario := '模型权限合并';
    v_result := api.resolve_dynamic_config('test_model_access_2', 'test_virtual_key_2', v_new_virtual_key_id, '{"tier_name": "test_pro_2", "user_type": "vip"}');
    actual_value := v_result->'allowed_models';
    status := CASE 
        WHEN v_result ? 'allowed_models' AND 
             jsonb_array_length(v_result->'allowed_models') >= 2 THEN 'PASS' 
        ELSE 'FAIL' 
    END;
    RETURN NEXT;
    
    -- 🧪 测试类别 3: 套餐支持性控制测试
    test_category := '套餐支持性控制';
    
    -- 测试场景 3.1: 不支持套餐的配置类型
    test_scenario := '不支持套餐的配置';
    INSERT INTO data.unified_config_store (config_type, level_name, scope_id, config_value) VALUES
    ('test_monitoring_2', 'test_platform_2', NULL, '{"enabled": true}');
    
    expected_value := '{"enabled": true}';
    v_result := api.resolve_dynamic_config('test_monitoring_2', 'test_virtual_key_2', v_new_virtual_key_id, '{"tier_name": "test_pro_2"}');
    actual_value := v_result;
    status := CASE WHEN v_result->>'enabled' = 'true' THEN 'PASS' ELSE 'FAIL' END;
    RETURN NEXT;
    
    RAISE NOTICE '✅ 完整配置系统测试完成！';
    
    -- 清理测试数据
 -- 在测试函数最后，按这个顺序清理：
DELETE FROM data.unified_config_store WHERE config_type LIKE 'test_%_2';
DELETE FROM data.tier_feature_mappings WHERE tier_name LIKE 'test_%_2' OR config_type LIKE 'test_%_2';
DELETE FROM data.inheritance_rules WHERE config_type LIKE 'test_%_2';
DELETE FROM data.config_types WHERE type_name LIKE 'test_%_2';
DELETE FROM data.config_levels WHERE level_name LIKE 'test_%_2'; 
DELETE FROM data.tier_definitions WHERE tier_name LIKE 'test_%_2';

    
END;
$$;


ALTER FUNCTION api.test_complete_config_system() OWNER TO geohuz;

--
-- Name: test_config_cleanup(uuid); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.test_config_cleanup(p_user_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    -- 清理用户相关数据
    DELETE FROM DATA.tier_feature_mappings WHERE id=p_user_id;
    RETURN true;
END;
$$;


ALTER FUNCTION api.test_config_cleanup(p_user_id uuid) OWNER TO geohuz;

--
-- Name: test_config_setup(); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.test_config_setup() RETURNS TABLE(setup_virtual_key text, setup_user_id uuid, setup_virtual_key_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_user_id UUID;
    v_virtual_key TEXT;
    v_virtual_key_id UUID;
BEGIN
    -- 创建测试用户
    v_user_id := api.register_user(
        'test_' || extract(epoch from now())::text || '@example.com',
        'testuser_' || extract(epoch from now())::text,
        'testpass123'
    );
    
    -- 创建 Virtual Key
    v_virtual_key := api.create_virtual_key(
        v_user_id,
        '测试密钥',
        '测试环境配置'
    );
    
    -- 获取 Virtual Key ID
    SELECT id INTO v_virtual_key_id
    FROM data.virtual_key
    WHERE virtual_key = v_virtual_key;
    
    -- 🟢 使用存在的函数设置配置
    PERFORM api.virtual_config_set(v_virtual_key, 'rate_limits', '{"rpm": 5000}');
    PERFORM api.virtual_config_set(v_virtual_key, 'model_access', '{"allowed_models": ["gpt-4"]}');
    
    -- 返回测试数据
    setup_virtual_key := v_virtual_key;
    setup_user_id := v_user_id;
    setup_virtual_key_id := v_virtual_key_id;
    
    RETURN NEXT;
END;
$$;


ALTER FUNCTION api.test_config_setup() OWNER TO geohuz;

--
-- Name: test_dynamic_config_system(); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.test_dynamic_config_system() RETURNS TABLE(test_name text, config_type text, target_level text, scope_id uuid, context jsonb, result jsonb, status text)
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_global_config_ids UUID[];
    v_tenant_config_ids UUID[];
    v_user_config_ids UUID[];
    v_virtual_key_config_ids UUID[];
    v_tenant_id UUID := gen_random_uuid();
    v_user_id UUID := gen_random_uuid();
    v_virtual_key_id UUID := gen_random_uuid();
    v_count INTEGER;
BEGIN
    -- 1. 初始化测试数据
    RAISE NOTICE '初始化测试数据...';
    
    -- 清理可能存在的测试数据
    DELETE FROM data.unified_config_store WHERE level_name LIKE 'test_%';
    DELETE FROM data.inheritance_rules WHERE parent_level LIKE 'test_%' OR child_level LIKE 'test_%';
    DELETE FROM data.tier_feature_mappings WHERE tier_name LIKE 'test_%';
    DELETE FROM data.tier_definitions WHERE tier_name LIKE 'test_%';
    DELETE FROM data.merge_strategies WHERE strategy_name IN ('override', 'deep_merge', 'array_merge', 'array_append');
    DELETE FROM data.config_types WHERE type_name LIKE 'test_%';
    DELETE FROM data.config_levels WHERE level_name LIKE 'test_%';
    
    -- 初始化层级
    INSERT INTO data.config_levels (level_name, display_name, parent_level, inherit_priority, description, is_system_level) VALUES 
    ('test_global', '测试全局', NULL, 1, '测试全局配置', false),
    ('test_tenant', '测试租户', 'test_global', 2, '测试租户配置', false),
    ('test_user', '测试用户', 'test_tenant', 3, '测试用户配置', false),
    ('test_virtual_key', '测试密钥', 'test_user', 4, '测试密钥配置', false);
    
    -- 初始化合并策略（修复：添加 array_append）
    INSERT INTO data.merge_strategies (strategy_name, description, implementation_function, is_builtin) VALUES 
    ('override', '完全覆盖', 'override_merge', true),
    ('deep_merge', '深度合并', 'deep_merge_impl', true),
    ('array_merge', '数组合并', 'array_merge_impl', true),
    ('array_append', '数组追加', 'array_append_impl', true);
    
    -- 初始化配置类型（修复：使用正确的合并策略名称）
    INSERT INTO data.config_types (type_name, display_name, value_schema, default_value, merge_strategy, description, is_system_type) VALUES 
    ('test_rate_limits', '测试速率限制', '{"type":"object"}', '{"rpm": 100, "tpm": 10000}', 'override', '测试速率限制', false),
    ('test_model_access', '测试模型权限', '{"type":"object"}', '{"allowed_models": ["gpt-3.5-turbo"]}', 'array_append', '测试模型权限', false); -- 改为 array_append
    
    -- 初始化套餐
    INSERT INTO data.tier_definitions (tier_name, display_name, description, pricing_model, base_price, currency) VALUES 
    ('test_standard', '测试标准版', '测试基础套餐', 'monthly', 0.00, 'CNY'),
    ('test_premium', '测试专业版', '测试高级套餐', 'monthly', 299.00, 'CNY');
    
    -- 初始化套餐特性
    INSERT INTO data.tier_feature_mappings (tier_name, config_type, feature_value) VALUES 
    ('test_premium', 'test_rate_limits', '{"rpm": 5000, "tpm": 500000}'),
    ('test_premium', 'test_model_access', '{"allowed_models": ["gpt-4", "claude-2"]}'),
    ('test_standard', 'test_rate_limits', '{"rpm": 1000, "tpm": 100000}');
    
    -- 初始化继承规则（修复：使用正确的策略名称）
INSERT INTO data.inheritance_rules (parent_level, child_level, config_type, is_inheritance_enabled, custom_merge_strategy, condition_description) VALUES 
('test_global', 'test_tenant', 'test_rate_limits', true, 'override', '测试继承规则'),
('test_global', 'test_tenant', 'test_model_access', true, 'array_append', '测试继承规则'),
('test_tenant', 'test_user', 'test_rate_limits', true, 'override', '测试继承规则'),
('test_tenant', 'test_user', 'test_model_access', true, 'array_append', '测试继承规则'),  -- 🟢 新增这条
('test_user', 'test_virtual_key', 'test_rate_limits', true, 'override', '测试继承规则'),
('test_user', 'test_virtual_key', 'test_model_access', true, 'array_append', '测试继承规则');  -- 🟢 新增这条
    
    -- 2. 设置测试配置数据
    RAISE NOTICE '设置测试配置...';
-- 🟢 移除全局速率限制配置，让套餐回退能正确触发
-- 只保留模型权限的全局配置
INSERT INTO data.unified_config_store (config_type, level_name, scope_id, config_value) 
VALUES ('test_model_access', 'test_global', NULL, '{"allowed_models": ["gpt-3.5-turbo", "qwen-turbo"]}');

-- 模型权限使用 NULL scope_id（默认配置）
INSERT INTO data.unified_config_store (config_type, level_name, scope_id, config_value) 
VALUES ('test_model_access', 'test_tenant', NULL, '{"allowed_models": ["claude-instant"]}');

INSERT INTO data.unified_config_store (config_type, level_name, scope_id, config_value) 
VALUES ('test_model_access', 'test_user', NULL, '{"allowed_models": ["user-model"]}');

-- 速率限制使用特定配置（有具体 scope_id）
INSERT INTO data.unified_config_store (config_type, level_name, scope_id, config_value) 
VALUES ('test_rate_limits', 'test_tenant', v_tenant_id, '{"rpm": 2500, "tpm": 250000}');

INSERT INTO data.unified_config_store (config_type, level_name, scope_id, config_value) 
VALUES ('test_rate_limits', 'test_user', v_user_id, '{"rpm": 3500, "tpm": 350000}');

INSERT INTO data.unified_config_store (config_type, level_name, scope_id, config_value) 
VALUES ('test_rate_limits', 'test_virtual_key', v_virtual_key_id, '{"rpm": 4000, "tpm": 400000}');

INSERT INTO data.unified_config_store (config_type, level_name, scope_id, config_value) 
VALUES ('test_model_access', 'test_virtual_key', v_virtual_key_id, '{"allowed_models": ["special-model"]}');
    
    -- 3. 执行测试用例
    RAISE NOTICE '开始执行测试用例...';
    
    -- 测试用例 1: 获取 Virtual Key 的速率限制（应该返回 4000）
    test_name := 'Virtual Key 速率限制';
    config_type := 'test_rate_limits';
    target_level := 'test_virtual_key';
    scope_id := v_virtual_key_id;
    context := '{"tier_name": "test_standard"}'::JSONB;
    BEGIN
        RAISE NOTICE '调用 resolve_dynamic_config: config_type=%, target_level=%, scope_id=%', 
            config_type, target_level, scope_id;
        result := api.resolve_dynamic_config(config_type, target_level, scope_id, context);
        status := CASE WHEN (result->>'rpm')::INTEGER = 4000 THEN 'PASS' ELSE 'FAIL' END;
    EXCEPTION WHEN OTHERS THEN
        result := jsonb_build_object('error', SQLERRM);
        status := 'ERROR';
    END;
    RETURN NEXT;
    
    -- 测试用例 2: 获取 Virtual Key 的模型权限（应该合并所有层级的模型）
    test_name := 'Virtual Key 模型权限合并';
    config_type := 'test_model_access';
    target_level := 'test_virtual_key';
    scope_id := v_virtual_key_id;
    context := '{"tier_name": "test_standard"}'::JSONB;
    BEGIN
        result := api.resolve_dynamic_config(config_type, target_level, scope_id, context); -- 修复：移除 level_name 参数
        status := CASE 
            WHEN result ? 'allowed_models' AND 
                 jsonb_array_length(result->'allowed_models') >= 4 THEN 'PASS' -- 期望合并所有模型
            ELSE 'FAIL' 
        END;
    EXCEPTION WHEN OTHERS THEN
        result := jsonb_build_object('error', SQLERRM);
        status := 'ERROR';
    END;
    RETURN NEXT;
    
    -- 测试用例 3: 获取用户级配置（应该返回 3500，覆盖租户配置）
    test_name := '用户级配置覆盖';
    config_type := 'test_rate_limits';
    target_level := 'test_user';
    scope_id := v_user_id;
    context := '{"tier_name": "test_standard"}'::JSONB;
    BEGIN
        result := api.resolve_dynamic_config(config_type, target_level, scope_id, context);
        status := CASE WHEN (result->>'rpm')::INTEGER = 3500 THEN 'PASS' ELSE 'FAIL' END;
    EXCEPTION WHEN OTHERS THEN
        result := jsonb_build_object('error', SQLERRM);
        status := 'ERROR';
    END;
    RETURN NEXT;

    -- 在测试用例4之前添加详细诊断
    RAISE NOTICE '=== 详细诊断套餐配置问题 ===';
    
    -- 诊断1：检查套餐配置是否存在
    SELECT COUNT(*) INTO v_count 
    FROM data.tier_feature_mappings tfm
    WHERE tfm.tier_name = 'test_premium' AND tfm.config_type = 'test_rate_limits';
    RAISE NOTICE '1. test_premium套餐配置数量: %', v_count;
    
    -- 诊断2：检查具体的套餐配置值
    SELECT tfm.feature_value INTO result 
    FROM data.tier_feature_mappings tfm
    WHERE tfm.tier_name = 'test_premium' AND tfm.config_type = 'test_rate_limits';
    RAISE NOTICE '2. test_premium套餐配置值: %', result;
    
    -- 诊断3：手动调用套餐函数测试
    result := api.get_tier_default_config('test_rate_limits', 'test_premium', '{"tier_name": "test_premium"}'::JSONB);
    RAISE NOTICE '3. 手动调用get_tier_default_config结果: %', result;
    
    -- 诊断4：检查全局默认值
    SELECT ct.default_value INTO result FROM data.config_types ct WHERE ct.type_name = 'test_rate_limits';
    RAISE NOTICE '4. 全局默认值: %', result;
    
    RAISE NOTICE '=== 诊断结束 ===';

    -- 测试用例 4: 套餐默认配置（使用 premium 套餐）
    test_name := '套餐默认配置(premium)';
    config_type := 'test_rate_limits';
    target_level := 'test_virtual_key';
    scope_id := gen_random_uuid(); -- 新的 Virtual Key，没有自定义配置
    context := '{"tier_name": "test_premium"}'::JSONB;
    BEGIN
        result := api.resolve_dynamic_config(config_type, target_level, scope_id, context);
        status := CASE WHEN (result->>'rpm')::INTEGER = 5000 THEN 'PASS' ELSE 'FAIL' END;
    EXCEPTION WHEN OTHERS THEN
        result := jsonb_build_object('error', SQLERRM);
        status := 'ERROR';
    END;
    RETURN NEXT;
    
    -- 测试用例 5: 套餐默认配置（使用 standard 套餐）
    test_name := '套餐默认配置(standard)';
    config_type := 'test_rate_limits';
    target_level := 'test_virtual_key';
    scope_id := gen_random_uuid(); -- 新的 Virtual Key，没有自定义配置
    context := '{"tier_name": "test_standard"}'::JSONB;
    BEGIN
        result := api.resolve_dynamic_config(config_type, target_level, scope_id, context);
        status := CASE WHEN (result->>'rpm')::INTEGER = 1000 THEN 'PASS' ELSE 'FAIL' END;
    EXCEPTION WHEN OTHERS THEN
        result := jsonb_build_object('error', SQLERRM);
        status := 'ERROR';
    END;
    RETURN NEXT;
    
    -- 🟢 新增测试用例 6: 真正的全局默认配置（没有套餐信息）
    test_name := '真正的全局默认配置';
    config_type := 'test_rate_limits';
    target_level := 'test_virtual_key';
    scope_id := gen_random_uuid(); -- 新的 Virtual Key
    context := '{}'::JSONB;  -- 🟢 关键：没有套餐信息
    BEGIN
        result := api.resolve_dynamic_config(config_type, target_level, scope_id, context);
        status := CASE WHEN (result->>'rpm')::INTEGER = 100 THEN 'PASS' ELSE 'FAIL' END;  -- 🟢 期望全局默认值 100
    EXCEPTION WHEN OTHERS THEN
        result := jsonb_build_object('error', SQLERRM);
        status := 'ERROR';
    END;
    RETURN NEXT;
    
    RAISE NOTICE '✅ 动态配置系统测试完成！';
    
    -- 4. 清理测试数据
    RAISE NOTICE '清理测试数据...';
    DELETE FROM data.unified_config_store WHERE level_name LIKE 'test_%';
    DELETE FROM data.tier_feature_mappings WHERE tier_name LIKE 'test_%';
    DELETE FROM data.tier_definitions WHERE tier_name LIKE 'test_%';
    DELETE FROM data.inheritance_rules WHERE condition_description LIKE '%测试%';
    DELETE FROM data.config_types WHERE type_name LIKE 'test_%';
    DELETE FROM data.config_levels WHERE level_name LIKE 'test_%';
    
END;
$$;


ALTER FUNCTION api.test_dynamic_config_system() OWNER TO geohuz;

--
-- Name: tier_feature_set(text, text, jsonb, jsonb, boolean); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.tier_feature_set(p_tier_name text, p_config_type text, p_feature_value jsonb, p_condition_expression jsonb DEFAULT NULL::jsonb, p_is_active boolean DEFAULT true) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_feature_id UUID;
BEGIN
    INSERT INTO data.tier_feature_mappings (
        tier_name, config_type, feature_value,
        condition_expression, is_active
    ) VALUES (
        p_tier_name, p_config_type, p_feature_value,
        p_condition_expression, p_is_active
    )
    RETURNING id INTO v_feature_id;
    
    PERFORM pg_notify('tier_updates', 
        jsonb_build_object(
            'action', 'set_feature',
            'tier_name', p_tier_name,
            'config_type', p_config_type,
            'feature_id', v_feature_id
        )::text
    );
    
    RETURN v_feature_id;
END;
$$;


ALTER FUNCTION api.tier_feature_set(p_tier_name text, p_config_type text, p_feature_value jsonb, p_condition_expression jsonb, p_is_active boolean) OWNER TO geohuz;

--
-- Name: topup_user(uuid, numeric, text, text, text); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.topup_user(p_user_id uuid, p_amount numeric, p_payment_reference text, p_payment_provider text, p_currency text DEFAULT 'rmb'::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    new_topup_id uuid;
BEGIN
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Amount must be positive';
    END IF;

    INSERT INTO data.topup_record(
        user_id, amount, currency,
        payment_reference, payment_provider,
        status
    ) VALUES (
        p_user_id, p_amount, p_currency,
        p_payment_reference, p_payment_provider,
        'pending'
    )
    RETURNING id INTO new_topup_id;

    RETURN new_topup_id;
END;
$$;


ALTER FUNCTION api.topup_user(p_user_id uuid, p_amount numeric, p_payment_reference text, p_payment_provider text, p_currency text) OWNER TO geohuz;

--
-- Name: unattach_virtualkey(uuid); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.unattach_virtualkey(p_virtual_key_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- 清空 primary_config_node_id，触发器会更新 computed_config 和通知
    UPDATE data.virtual_key
    SET primary_config_node_id = NULL
    WHERE id = p_virtual_key_id;
END;
$$;


ALTER FUNCTION api.unattach_virtualkey(p_virtual_key_id uuid) OWNER TO geohuz;

--
-- Name: unblacklist_user(uuid, text); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.unblacklist_user(p_user_id uuid, p_reason text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_log_id UUID;
    v_old_status TEXT;
    v_admin_id UUID;
BEGIN
    -- 获取管理员ID
    v_admin_id := (current_setting('request.jwt.claims', true)::json->>'userid')::UUID;

    -- 获取当前状态
    SELECT status INTO v_old_status
    FROM data.user_profile 
    WHERE user_id = p_user_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User not found: %', p_user_id;
    END IF;

    IF v_old_status != 'blacklisted' THEN
        RAISE EXCEPTION 'User is not blacklisted, current status: %', v_old_status;
    END IF;

    -- 恢复到 active 状态
    PERFORM internal.change_user_status(p_user_id, 'active');
    
    -- 记录审计日志
    INSERT INTO data.audit_log (
        actor_id, 
        action, 
        target_id,
        detail
    ) VALUES (
        v_admin_id,
        'unblacklist_user',
        p_user_id,
        jsonb_build_object(
            'old_status', 'blacklisted',
            'new_status', 'active', 
            'reason', p_reason
        )
    ) RETURNING id INTO v_log_id;
    
    RETURN v_log_id;
END;
$$;


ALTER FUNCTION api.unblacklist_user(p_user_id uuid, p_reason text) OWNER TO geohuz;

--
-- Name: update_portkey_config(uuid, jsonb, timestamp with time zone, text, uuid); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.update_portkey_config(p_id uuid, p_config_json jsonb, p_effective_from timestamp with time zone, p_notes text, p_updated_by uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    current_version integer;
    new_version integer;
    current_tenant_id uuid;
    current_user_id uuid;
BEGIN
    SELECT version, tenant_id, user_id INTO current_version, current_tenant_id, current_user_id
    FROM data.portkey_configs WHERE id = p_id FOR UPDATE;

    IF current_version IS NULL THEN
        RAISE EXCEPTION 'Config not found';
    END IF;

    new_version := current_version + 1;

    -- 验证 JSON
    IF NOT api.validate_portkey_config_json(p_config_json) THEN
        RAISE EXCEPTION 'Invalid Portkey config JSON';
    END IF;

    UPDATE data.portkey_configs
    SET config_json = p_config_json,
        version = new_version,
        effective_from = p_effective_from,
        notes = p_notes,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = p_id;

    -- 插入 history
    INSERT INTO data.portkey_config_history (config_id, tenant_id, user_id, config_json, version, effective_from, changed_by, change_type, notes)
    VALUES (p_id, current_tenant_id, current_user_id, p_config_json, new_version, p_effective_from, p_updated_by, 'update', p_notes);

    -- 通知
    -- 🆕 修复：提供完整的更新信息
    PERFORM pg_notify('config_update', 
        jsonb_build_object(
            'action', 'update',
            'config_id', p_id,
            'tenant_id', current_tenant_id,
            'user_id', current_user_id,
            'version', new_version,
            'timestamp', extract(epoch from now())::text
        )::text
    );


    RETURN p_id;
END;
$$;


ALTER FUNCTION api.update_portkey_config(p_id uuid, p_config_json jsonb, p_effective_from timestamp with time zone, p_notes text, p_updated_by uuid) OWNER TO geohuz;

--
-- Name: update_provider_rate(text, text, numeric, numeric, numeric, text, text, timestamp with time zone, text, uuid); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.update_provider_rate(p_provider text, p_model text, p_input_rate numeric, p_output_rate numeric, p_request_rate numeric DEFAULT 0, p_pricing_model text DEFAULT 'per_token'::text, p_currency text DEFAULT 'usd'::text, p_effective_from timestamp with time zone DEFAULT now(), p_notes text DEFAULT NULL::text, p_created_by uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'data'
    AS $$
DECLARE
    v_old_rate_id UUID;
    v_new_rate_id UUID;
    v_next_version INTEGER;
BEGIN
    -- 获取下一个版本号
    SELECT COALESCE(MAX(version), 0) + 1 INTO v_next_version
    FROM provider_rate 
    WHERE provider = p_provider AND model = p_model;
    
    -- 停用当前有效费率
    UPDATE provider_rate 
    SET effective_to = p_effective_from,
        is_active = false,
        updated_at = NOW()
    WHERE provider = p_provider 
      AND model = p_model 
      AND is_active = true 
      AND effective_to IS NULL
    RETURNING id INTO v_old_rate_id;
    
    -- 插入新费率
    INSERT INTO provider_rate (
        provider, model, 
        price_per_token, -- 保持向后兼容
        price_per_input_token, price_per_output_token, price_per_request,
        pricing_model, currency,
        effective_from, notes, created_by,
        version, previous_version_id
    ) VALUES (
        p_provider, p_model,
        (p_input_rate + p_output_rate) / 2,
        p_input_rate, p_output_rate, p_request_rate,
        p_pricing_model, p_currency,
        p_effective_from, p_notes, p_created_by,
        v_next_version, v_old_rate_id
    ) RETURNING id INTO v_new_rate_id;
    
    RETURN v_new_rate_id;
END;
$$;


ALTER FUNCTION api.update_provider_rate(p_provider text, p_model text, p_input_rate numeric, p_output_rate numeric, p_request_rate numeric, p_pricing_model text, p_currency text, p_effective_from timestamp with time zone, p_notes text, p_created_by uuid) OWNER TO geohuz;

--
-- Name: update_virtual_key(text, text, text, integer, integer, text[], uuid, text, boolean); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.update_virtual_key(p_virtual_key text, p_name text DEFAULT NULL::text, p_description text DEFAULT NULL::text, p_rate_limit_rpm integer DEFAULT NULL::integer, p_rate_limit_tpm integer DEFAULT NULL::integer, p_allowed_models text[] DEFAULT NULL::text[], p_key_type_id uuid DEFAULT NULL::uuid, p_key_prefix text DEFAULT NULL::text, p_is_active boolean DEFAULT NULL::boolean) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_virtual_key_id UUID;
    v_user_id UUID;
    v_old_data jsonb;
BEGIN
    -- 获取旧数据用于审计（包含新增字段）
    SELECT id, user_id, 
           jsonb_build_object(
               'name', name,
               'description', description, 
               'rate_limit_rpm', rate_limit_rpm,
               'rate_limit_tpm', rate_limit_tpm,
               'allowed_models', allowed_models,
               'key_type_id', key_type_id,        -- 🟢 新增
               'key_prefix', key_prefix,          -- 🟢 新增
               'is_active', is_active             -- 🟢 新增
           ) INTO v_virtual_key_id, v_user_id, v_old_data
    FROM data.virtual_key 
    WHERE virtual_key = p_virtual_key  -- 🟢 移除 is_active 条件，允许更新非激活的密钥
    FOR UPDATE;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Virtual key not found: %', p_virtual_key;
    END IF;
    
    -- 更新字段（包含新增字段）
    UPDATE data.virtual_key 
    SET name = COALESCE(p_name, name),
        description = COALESCE(p_description, description),
        rate_limit_rpm = COALESCE(p_rate_limit_rpm, rate_limit_rpm),
        rate_limit_tpm = COALESCE(p_rate_limit_tpm, rate_limit_tpm),
        allowed_models = COALESCE(p_allowed_models, allowed_models),
        key_type_id = COALESCE(p_key_type_id, key_type_id),      -- 🟢 新增
        key_prefix = COALESCE(p_key_prefix, key_prefix),         -- 🟢 新增
        is_active = COALESCE(p_is_active, is_active),            -- 🟢 新增
        updated_at = NOW()
    WHERE virtual_key = p_virtual_key;
    
    -- 更新通知（包含新增字段）
    PERFORM pg_notify('virtual_key_update', 
        jsonb_build_object(
            'action', 'update',
            'virtual_key_id', v_virtual_key_id,
            'virtual_key', p_virtual_key,
            'user_id', v_user_id,
            'old_data', v_old_data,
            'new_data', jsonb_build_object(
                'name', COALESCE(p_name, (v_old_data->>'name')),
                'description', COALESCE(p_description, (v_old_data->>'description')),
                'rate_limit_rpm', COALESCE(p_rate_limit_rpm, (v_old_data->>'rate_limit_rpm')::integer),
                'rate_limit_tpm', COALESCE(p_rate_limit_tpm, (v_old_data->>'rate_limit_tpm')::integer),
                'allowed_models', COALESCE(p_allowed_models, 
                    CASE 
                        WHEN v_old_data->>'allowed_models' IS NOT NULL 
                        THEN (v_old_data->>'allowed_models')::text[]
                        ELSE '{}'::text[]
                    END),
                'key_type_id', COALESCE(p_key_type_id, (v_old_data->>'key_type_id')::uuid),  -- 🟢 新增
                'key_prefix', COALESCE(p_key_prefix, v_old_data->>'key_prefix'),             -- 🟢 新增
                'is_active', COALESCE(p_is_active, (v_old_data->>'is_active')::boolean)      -- 🟢 新增
            ),
            'timestamp', extract(epoch from now())::text
        )::text
    );
END;
$$;


ALTER FUNCTION api.update_virtual_key(p_virtual_key text, p_name text, p_description text, p_rate_limit_rpm integer, p_rate_limit_tpm integer, p_allowed_models text[], p_key_type_id uuid, p_key_prefix text, p_is_active boolean) OWNER TO geohuz;

--
-- Name: validate_portkey_config_json(jsonb); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.validate_portkey_config_json(p_json jsonb) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- 示例：检查必需键
    IF p_json ? 'strategy' AND p_json ? 'targets' THEN
        RETURN true;
    ELSE
        RETURN false;
    END IF;
END;
$$;


ALTER FUNCTION api.validate_portkey_config_json(p_json jsonb) OWNER TO geohuz;

--
-- Name: virtual_config_resolve(text, jsonb); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.virtual_config_resolve(p_virtual_key text, p_context jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_virtual_key_id UUID;
    v_user_id UUID;
BEGIN
    -- 获取 Virtual Key 信息
    SELECT id, user_id INTO v_virtual_key_id, v_user_id
    FROM data.virtual_key
    WHERE virtual_key = p_virtual_key;
    
    IF v_virtual_key_id IS NULL THEN
        RAISE EXCEPTION 'Virtual Key 不存在: %', p_virtual_key;
    END IF;
    
    -- 构建完整上下文
    RETURN api.resolve_dynamic_config(
        'gateway_routing',  -- 或其他需要的配置类型
        'virtual_key',
        v_virtual_key_id,
        jsonb_build_object(
            'virtual_key', p_virtual_key,
            'user_id', v_user_id
        ) || p_context
    );
END;
$$;


ALTER FUNCTION api.virtual_config_resolve(p_virtual_key text, p_context jsonb) OWNER TO geohuz;

--
-- Name: virtual_config_set(text, text, jsonb); Type: FUNCTION; Schema: api; Owner: geohuz
--

CREATE FUNCTION api.virtual_config_set(p_virtual_key text, p_config_type text, p_config_value jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_virtual_key_id UUID;
BEGIN
    -- 获取 Virtual Key ID
    SELECT id INTO v_virtual_key_id
    FROM data.virtual_key
    WHERE virtual_key = p_virtual_key;
    
    IF v_virtual_key_id IS NULL THEN
        RAISE EXCEPTION 'Virtual Key 不存在: %', p_virtual_key;
    END IF;
    
    -- 调用通用配置函数
    RETURN api.config_create(
        p_config_type,
        'virtual_key',
        p_config_value,
        v_virtual_key_id
    );
END;
$$;


ALTER FUNCTION api.virtual_config_set(p_virtual_key text, p_config_type text, p_config_value jsonb) OWNER TO geohuz;

--
-- Name: check_role_exists(); Type: FUNCTION; Schema: auth; Owner: geohuz
--

CREATE FUNCTION auth.check_role_exists() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if not exists (select 1 from pg_roles as r where r.rolname = new.role) then
    raise foreign_key_violation using message =
      'unknown database role: ' || new.role;
    return null;
  end if;
  return new;
end
$$;


ALTER FUNCTION auth.check_role_exists() OWNER TO geohuz;

--
-- Name: encrypt_pass(); Type: FUNCTION; Schema: auth; Owner: geohuz
--

CREATE FUNCTION auth.encrypt_pass() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'INSERT' or new.hashed_password <> old.hashed_password then
    new.hashed_password = crypt(new.hashed_password, gen_salt('bf'));
  end if;
  return new;
end
$$;


ALTER FUNCTION auth.encrypt_pass() OWNER TO geohuz;

--
-- Name: user_role(text, text); Type: FUNCTION; Schema: auth; Owner: geohuz
--

CREATE FUNCTION auth.user_role(email text, pass text) RETURNS TABLE(role text, userid uuid)
    LANGUAGE plpgsql
    AS $$
begin
  return query
  select l.role AS role, l.id AS userid
  from auth.login l
  where l.email = user_role.email
     and l.hashed_password = crypt(user_role.pass, l.hashed_password)
  ;
end;
$$;


ALTER FUNCTION auth.user_role(email text, pass text) OWNER TO geohuz;

--
-- Name: after_node_config_update(); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.after_node_config_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- 异步更新所有子节点的配置
    PERFORM data.update_children_config(NEW.id);
    RETURN NEW;
END;
$$;


ALTER FUNCTION data.after_node_config_update() OWNER TO geohuz;

--
-- Name: check_scope_constraint(); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.check_scope_constraint() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- 查询层级定义，判断是否为根层级（全局层级）
    IF EXISTS (
        SELECT 1 FROM data.config_levels 
        WHERE level_name = NEW.level_name 
        AND parent_level IS NULL  -- 根层级的特征：没有父级
    ) THEN
        -- 根层级：scope_id 必须为 NULL（全局配置没有具体对象）
        IF NEW.scope_id IS NOT NULL THEN
            RAISE EXCEPTION '根层级 "%" 的 scope_id 必须为 NULL，因为这是全局配置', NEW.level_name;
        END IF;
    ELSE
        -- 非根层级：scope_id 可以为 NULL（默认配置）或具体值（特定实体配置）
        -- 不进行限制，允许两种方式
    END IF;
    
    RETURN NEW;
END;
$$;


ALTER FUNCTION data.check_scope_constraint() OWNER TO geohuz;

--
-- Name: compute_config_for_node(uuid); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.compute_config_for_node(p_node_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_current_config JSONB;
    v_parent_config JSONB;
    v_parent_id UUID;
BEGIN
    -- 获取当前节点的配置和父节点ID
    SELECT config_data, parent_id INTO v_current_config, v_parent_id
    FROM data.config_nodes WHERE id = p_node_id;
   
    -- 如果有父节点，获取父节点的计算配置
    IF v_parent_id IS NOT NULL THEN
        SELECT computed_config INTO v_parent_config
        FROM data.config_nodes WHERE id = v_parent_id;
    END IF;
   
    -- 深层合并：父节点配置 + 当前节点配置（当前节点覆盖/合并到父节点）
    RETURN data.jsonb_deep_merge(COALESCE(v_parent_config, '{}'::JSONB), COALESCE(v_current_config, '{}'::JSONB));
END;
$$;


ALTER FUNCTION data.compute_config_for_node(p_node_id uuid) OWNER TO geohuz;

--
-- Name: compute_config_for_user(uuid); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.compute_config_for_user(p_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_user_config JSONB;
    v_node_config JSONB;
    v_node_id UUID;
BEGIN
    -- 获取用户的配置和 primary_config_node_id
    SELECT config_data, primary_config_node_id INTO v_user_config, v_node_id
    FROM data.user_profile WHERE user_id = p_user_id;
   
    -- 如果有 primary_config_node_id，获取该节点的 computed_config
    IF v_node_id IS NOT NULL THEN
        SELECT computed_config INTO v_node_config
        FROM data.config_nodes WHERE id = v_node_id;
    END IF;
   
    -- 深层合并：节点配置 + 用户配置（用户配置覆盖/合并到节点配置）
    RETURN data.jsonb_deep_merge(COALESCE(v_node_config, '{}'::JSONB), COALESCE(v_user_config, '{}'::JSONB));
END;
$$;


ALTER FUNCTION data.compute_config_for_user(p_user_id uuid) OWNER TO geohuz;

--
-- Name: compute_config_for_user(uuid, jsonb); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.compute_config_for_user(p_node_id uuid, p_user_config jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_node_config JSONB;
BEGIN
    -- 如果有 primary_config_node_id，获取该节点的 computed_config
    IF p_node_id IS NOT NULL THEN
        SELECT computed_config INTO v_node_config
        FROM data.config_nodes WHERE id = p_node_id;
    END IF;
   
    -- 深层合并：节点配置 + 用户配置（用户配置覆盖/合并到节点配置）
    RETURN data.jsonb_deep_merge(COALESCE(v_node_config, '{}'::JSONB), COALESCE(p_user_config, '{}'::JSONB));
END;
$$;


ALTER FUNCTION data.compute_config_for_user(p_node_id uuid, p_user_config jsonb) OWNER TO geohuz;

--
-- Name: compute_node_config(); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.compute_node_config() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- 如果是根节点（没有父节点），直接使用自己的配置
    IF NEW.parent_id IS NULL THEN
        NEW.computed_config := COALESCE(NEW.config_data, '{}'::JSONB);
    ELSE
        -- 如果有父节点，使用计算函数（包含深层合并）
        NEW.computed_config := data.compute_config_for_node(NEW.id);
    END IF;
   
    RETURN NEW;
END;
$$;


ALTER FUNCTION data.compute_node_config() OWNER TO geohuz;

--
-- Name: compute_user_config(); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.compute_user_config() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- 使用 NEW 的 primary_config_node_id 和 config_data 计算 computed_config
    NEW.computed_config := data.compute_config_for_user(NEW.primary_config_node_id, NEW.config_data);
   
    RETURN NEW;
END;
$$;


ALTER FUNCTION data.compute_user_config() OWNER TO geohuz;

--
-- Name: jsonb_deep_merge(jsonb, jsonb); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.jsonb_deep_merge(left_json jsonb, right_json jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
SELECT
    jsonb_object_agg(
        COALESCE(ka, kb),
        CASE
            WHEN va IS NULL THEN vb
            WHEN vb IS NULL THEN va
            WHEN va = vb THEN vb  -- 额外检查：如果值相等，直接用 vb（优化，但非必须）
            WHEN jsonb_typeof(va) <> 'object' OR jsonb_typeof(vb) <> 'object' THEN vb  -- 非对象时，右值覆盖
            ELSE data.jsonb_deep_merge(va, vb)  -- 两者均为对象时，递归合并
        END
    )
FROM jsonb_each(left_json) AS l(ka, va)
FULL JOIN jsonb_each(right_json) AS r(kb, vb) ON ka = kb;
$$;


ALTER FUNCTION data.jsonb_deep_merge(left_json jsonb, right_json jsonb) OWNER TO geohuz;

--
-- Name: mark_node_dirty(); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.mark_node_dirty() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.is_dirty := true;
    RETURN NEW;
END;
$$;


ALTER FUNCTION data.mark_node_dirty() OWNER TO geohuz;

--
-- Name: notify_account_balance_update(); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.notify_account_balance_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    payload json;
BEGIN
    payload := json_build_object(
        'account_id', COALESCE(NEW.owner_tenantid, NEW.owner_userid),
        'account_type', CASE
            WHEN NEW.owner_tenantid IS NOT NULL THEN 'tenant'
            ELSE 'user'
        END
    );

    PERFORM pg_notify('account_balance_updated', payload::text);

    RETURN NEW;
END;
$$;


ALTER FUNCTION data.notify_account_balance_update() OWNER TO geohuz;

--
-- Name: notify_config_change(); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.notify_config_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_payload JSONB;
    v_virtual_key TEXT;
    v_tier_name TEXT;
    v_config_type TEXT;
BEGIN
    -- 构建通知负载
    v_payload := json_build_object(
        'table', TG_TABLE_NAME,
        'action', TG_OP,
        'timestamp', NOW()
    );

    -- 根据不同表提取关键信息
    CASE TG_TABLE_NAME
        WHEN 'unified_config_store' THEN
            v_payload := v_payload || jsonb_build_object(
                'level_name', COALESCE(NEW.level_name, OLD.level_name),
                'config_type', COALESCE(NEW.config_type, OLD.config_type),
                'scope_id', COALESCE(NEW.scope_id, OLD.scope_id)
            );
            -- 尝试推断 virtual_key
            IF COALESCE(NEW.scope_id, OLD.scope_id) IS NOT NULL AND COALESCE(NEW.level_name, OLD.level_name) = 'virtual_key' THEN
                v_payload := v_payload || jsonb_build_object('virtual_key', COALESCE(NEW.scope_id, OLD.scope_id)::text);
            END IF;

        WHEN 'tier_feature_mappings' THEN
            v_payload := v_payload || jsonb_build_object(
                'tier_name', COALESCE(NEW.tier_name, OLD.tier_name),
                'config_type', COALESCE(NEW.config_type, OLD.config_type)
            );

        WHEN 'inheritance_rules' THEN
            v_payload := v_payload || jsonb_build_object(
                'parent_level', COALESCE(NEW.parent_level, OLD.parent_level),
                'child_level', COALESCE(NEW.child_level, OLD.child_level),
                'config_type', COALESCE(NEW.config_type, OLD.config_type)
            );

        WHEN 'config_types' THEN
            v_payload := v_payload || jsonb_build_object(
                'type_name', COALESCE(NEW.type_name, OLD.type_name)
            );

        WHEN 'config_levels' THEN
            v_payload := v_payload || jsonb_build_object(
                'level_name', COALESCE(NEW.level_name, OLD.level_name)
            );
    END CASE;

    -- 发送通知
    PERFORM pg_notify('config_updates', v_payload::text);
    
    RETURN NEW;
END;
$$;


ALTER FUNCTION data.notify_config_change() OWNER TO geohuz;

--
-- Name: notify_customer_type_rate_update(); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.notify_customer_type_rate_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE 
  ct_id uuid;
BEGIN
  -- 针对不同操作，NEW 或 OLD 都可能含有 customer_type_id
  ct_id := COALESCE(NEW.customer_type_id, OLD.customer_type_id);

  PERFORM pg_notify('customer_type_rate_update', ct_id::text);
  RETURN NEW;
END;
$$;


ALTER FUNCTION data.notify_customer_type_rate_update() OWNER TO geohuz;

--
-- Name: notify_node_change(); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.notify_node_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM pg_notify('node_changed', NEW.id::text);
    RETURN NEW;
END;
$$;


ALTER FUNCTION data.notify_node_change() OWNER TO geohuz;

--
-- Name: notify_node_changed(); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.notify_node_changed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ DECLARE vk_ids text[]; BEGIN SELECT array_agg(id) INTO vk_ids FROM data.virtual_key WHERE primary_config_node_id = NEW.id; PERFORM pg_notify( 'node_changed', json_build_object( 'node_id', NEW.id, 'virtual_key_ids', COALESCE(vk_ids, ARRAY[]::text[]) )::text ); RETURN NEW; END; $$;


ALTER FUNCTION data.notify_node_changed() OWNER TO geohuz;

--
-- Name: on_node_change(); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.on_node_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- ⚡ 注意这里用 PERFORM，而不是 SELECT
    PERFORM data.refresh_node_and_descendants(NEW.id);
    RETURN NEW;
END;
$$;


ALTER FUNCTION data.on_node_change() OWNER TO geohuz;

--
-- Name: prevent_inheritance_cycle(); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.prevent_inheritance_cycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_has_cycle BOOLEAN;
BEGIN
    -- 继承无环保障 `prevent_inheritance_cycle`
    -- 检查是否形成循环继承
    WITH RECURSIVE inheritance_chain AS (
        SELECT 
            NEW.child_level as current_level,
            NEW.parent_level as next_level,
            1 as depth
        UNION ALL
        SELECT 
            ic.next_level as current_level,
            ir.parent_level as next_level,
            ic.depth + 1
        FROM inheritance_chain ic
        JOIN data.inheritance_rules ir ON ir.child_level = ic.next_level
        WHERE ir.config_type = NEW.config_type
          AND ir.is_inheritance_enabled = true
          AND ir.is_active = true
          AND ic.depth < 10  -- 防止无限递归
    )
    SELECT EXISTS(
        SELECT 1 FROM inheritance_chain 
        WHERE next_level = NEW.child_level  -- 检测循环：是否回到起点
    ) INTO v_has_cycle;
    
    IF v_has_cycle THEN
        RAISE EXCEPTION '继承规则形成循环: % -> % -> %', 
            NEW.parent_level, NEW.child_level, NEW.child_level;
    END IF;
    
    RETURN NEW;
END;
$$;


ALTER FUNCTION data.prevent_inheritance_cycle() OWNER TO geohuz;

--
-- Name: prevent_unsupported_tier_features(); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.prevent_unsupported_tier_features() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- 防止为不支持套餐的配置类型创建套餐特性
    IF NOT EXISTS (
        SELECT 1 FROM data.config_types 
        WHERE type_name = NEW.config_type 
        AND supports_tier_entitlements = true
    ) THEN
        RAISE EXCEPTION '配置类型"%s"不支持套餐特性，无法创建套餐映射', NEW.config_type;
    END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION data.prevent_unsupported_tier_features() OWNER TO geohuz;

--
-- Name: prevent_unsupported_tier_references(); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.prevent_unsupported_tier_references() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- 防止在不支持套餐的配置上设置applied_tier
    IF NEW.applied_tier IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM data.config_types 
        WHERE type_name = NEW.config_type 
        AND supports_tier_entitlements = true
    ) THEN
        RAISE EXCEPTION '配置类型"%s"不支持套餐，不能设置applied_tier', NEW.config_type;
    END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION data.prevent_unsupported_tier_references() OWNER TO geohuz;

--
-- Name: refresh_all_configs(); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.refresh_all_configs() RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    r RECORD;
BEGIN
    -- 先生成节点列表（父 → 子）
    WITH RECURSIVE nodes AS (
        SELECT 
            id,
            parent_id,
            config_data,
            1 AS lvl
        FROM data.config_nodes
        WHERE parent_id IS NULL

        UNION ALL

        SELECT 
            c.id,
            c.parent_id,
            c.config_data,
            n.lvl + 1
        FROM data.config_nodes c
        JOIN nodes n ON c.parent_id = n.id
    )

    -- ←←← 注意：这里必须是一个 SQL 结束符号！
    -- 不能立即接 FOR，否则会报你现在的错误

    SELECT 1;   -- 占位，使 CTE 结束（内容无所谓）

    -- 现在进入 PL/pgSQL 的 FOR 循环
    FOR r IN
        SELECT id, parent_id, config_data
        FROM nodes
        ORDER BY lvl
    LOOP

        IF r.parent_id IS NULL THEN
            UPDATE data.config_nodes
            SET computed_config = r.config_data
            WHERE id = r.id;
        ELSE
            UPDATE data.config_nodes
            SET computed_config = data.jsonb_deep_merge(
                (SELECT computed_config 
                 FROM data.config_nodes 
                 WHERE id = r.parent_id),
                r.config_data
            )
            WHERE id = r.id;
        END IF;

    END LOOP;

END;
$$;


ALTER FUNCTION data.refresh_all_configs() OWNER TO geohuz;

--
-- Name: refresh_node_and_descendants(uuid); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.refresh_node_and_descendants(target_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    r RECORD;
    result jsonb;  -- 用来储存 target 节点的最终 computed_config
BEGIN
    -- 按层级生成节点列表并循环处理
    FOR r IN
        WITH RECURSIVE tree AS (
            SELECT id, parent_id, config_data, 1 AS lvl
            FROM data.config_nodes
            WHERE id = target_id

            UNION ALL

            SELECT c.id, c.parent_id, c.config_data, t.lvl + 1
            FROM data.config_nodes c
            JOIN tree t ON c.parent_id = t.id
        )
        SELECT id, parent_id, config_data, lvl
        FROM tree
        ORDER BY lvl
    LOOP
        IF r.parent_id IS NULL THEN
            -- root 节点
            UPDATE data.config_nodes
            SET computed_config = r.config_data
            WHERE id = r.id;

            IF r.id = target_id THEN
                result := r.config_data;
            END IF;

        ELSE
            -- 子节点：合并父节点 computed_config
            UPDATE data.config_nodes
            SET computed_config = data.jsonb_deep_merge(
                (SELECT computed_config FROM data.config_nodes WHERE id = r.parent_id),
                r.config_data
            )
            WHERE id = r.id;

            IF r.id = target_id THEN
                SELECT computed_config INTO result
                FROM data.config_nodes
                WHERE id = r.id;
            END IF;
        END IF;
    END LOOP;

    RETURN COALESCE(result, '{}'::jsonb);
END;
$$;


ALTER FUNCTION data.refresh_node_and_descendants(target_id uuid) OWNER TO geohuz;

--
-- Name: refresh_node_branch(uuid); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.refresh_node_branch(node_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    r RECORD;
BEGIN
    -- 1. 找到整条父链 + 子树
    WITH RECURSIVE tree AS (
        -- 向上走到 root
        SELECT id, parent_id, config_data
        FROM data.config_nodes
        WHERE id = node_id
        
        UNION ALL
        
        SELECT c.id, c.parent_id, c.config_data
        FROM data.config_nodes c
        JOIN tree t ON c.parent_id = t.id
    )
    SELECT * FROM tree;
    
    -- 2. 找全部子节点（按 parent → child）
    FOR r IN
        WITH RECURSIVE nodes AS (
            SELECT id, parent_id, config_data, 1 AS lvl
            FROM data.config_nodes WHERE parent_id IS NULL
            
            UNION ALL
            
            SELECT c.id, c.parent_id, c.config_data, n.lvl + 1
            FROM data.config_nodes c
            JOIN nodes n ON c.parent_id = n.id
        )
        SELECT * FROM nodes ORDER BY lvl
    LOOP
        IF r.parent_id IS NULL THEN
            UPDATE data.config_nodes
            SET computed_config = r.config_data,
                is_dirty = false
            WHERE id = r.id;
        ELSE
            UPDATE data.config_nodes
            SET computed_config = data.jsonb_deep_merge(
                (SELECT computed_config FROM data.config_nodes WHERE id = r.parent_id),
                r.config_data
            ),
            is_dirty = false
            WHERE id = r.id;
        END IF;
    END LOOP;
END;
$$;


ALTER FUNCTION data.refresh_node_branch(node_id uuid) OWNER TO geohuz;

--
-- Name: refresh_user_computed_config(uuid); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.refresh_user_computed_config(p_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_node_config jsonb;
    v_user_config jsonb;
BEGIN
    SELECT n.computed_config, u.config_data
    INTO v_node_config, v_user_config
    FROM data.user_profile u
    JOIN data.config_nodes n ON n.id = u.primary_config_node_id
    WHERE u.user_id = p_user_id;

    IF v_node_config IS NULL THEN
        v_node_config := '{}'::jsonb;
    END IF;
    IF v_user_config IS NULL THEN
        v_user_config := '{}'::jsonb;
    END IF;

    UPDATE data.user_profile
    SET computed_config = data.jsonb_deep_merge(v_node_config, v_user_config)
    WHERE user_id = p_user_id
    RETURNING computed_config INTO v_user_config;

    RETURN v_user_config;
END;
$$;


ALTER FUNCTION data.refresh_user_computed_config(p_user_id uuid) OWNER TO geohuz;

--
-- Name: refresh_user_configs(); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.refresh_user_configs() RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    user_record RECORD;
BEGIN
    FOR user_record IN SELECT user_id, primary_config_node_id, config_data FROM data.user_profile
    LOOP
        UPDATE data.user_profile
        SET computed_config = data.compute_config_for_user(user_record.primary_config_node_id, user_record.config_data)
        WHERE user_id = user_record.user_id;
    END LOOP;
END;
$$;


ALTER FUNCTION data.refresh_user_configs() OWNER TO geohuz;

--
-- Name: refresh_virtual_key_computed_config(uuid); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.refresh_virtual_key_computed_config(p_virtual_key_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    base_config jsonb;
    vk record;
BEGIN
    SELECT * INTO vk
    FROM data.virtual_key
    WHERE id = p_virtual_key_id;

    IF vk.primary_config_node_id IS NULL THEN
        RETURN vk.config_data;
    END IF;

base_config := COALESCE(
    data.refresh_node_and_descendants(vk.primary_config_node_id),
    '{}'::jsonb
);



    RETURN base_config || vk.config_data;
END;
$$;


ALTER FUNCTION data.refresh_virtual_key_computed_config(p_virtual_key_id uuid) OWNER TO geohuz;

--
-- Name: refresh_virtual_keys_for_node(uuid); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.refresh_virtual_keys_for_node(p_node_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT virtual_key_id
    FROM data.node_virtual_key_map
    WHERE node_id = p_node_id
  LOOP
    -- 逐个刷新 virtual_key 的 computed_config
    PERFORM data.refresh_virtual_key_computed_config(r.virtual_key_id);

    -- 通知 Node.js 清缓存（payload 用 virtual_key_id）
    PERFORM pg_notify('virtual_key_config_changed', r.virtual_key_id::text);
  END LOOP;
END;
$$;


ALTER FUNCTION data.refresh_virtual_keys_for_node(p_node_id uuid) OWNER TO geohuz;

--
-- Name: update_children_config(uuid); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.update_children_config(p_parent_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    child_record RECORD;
BEGIN
    FOR child_record IN 
        SELECT id FROM data.config_nodes WHERE parent_id = p_parent_id
    LOOP
        -- 直接计算配置并更新
        UPDATE data.config_nodes 
        SET computed_config = data.compute_config_for_node(child_record.id)
        WHERE id = child_record.id;
        
        -- 递归更新孙子节点
        PERFORM data.update_children_config(child_record.id);
    END LOOP;
END;
$$;


ALTER FUNCTION data.update_children_config(p_parent_id uuid) OWNER TO geohuz;

--
-- Name: update_timestamp(); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.update_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


ALTER FUNCTION data.update_timestamp() OWNER TO geohuz;

--
-- Name: userid(); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.userid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
    select 
    case coalesce(current_setting('request.jwt.claims', true)::json->>'userid'::text, '')
	when '' then null
	else (current_setting('request.jwt.claims', true)::json->>'userid'::text)::uuid
    end 
$$;


ALTER FUNCTION data.userid() OWNER TO geohuz;

--
-- Name: validate_config_effective_period(); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.validate_config_effective_period() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- 时间有效性保障
    -- 生效时间不能晚于失效时间
    IF NEW.effective_to IS NOT NULL AND NEW.effective_from > NEW.effective_to THEN
        RAISE EXCEPTION '配置生效时间(%)不能晚于失效时间(%)', 
            NEW.effective_from, NEW.effective_to;
    END IF;
    
    -- 失效时间不能是过去的时间（除非是历史配置）
    IF NEW.effective_to IS NOT NULL AND NEW.effective_to < NOW() THEN
        RAISE NOTICE '警告：配置失效时间(%)是过去时间', NEW.effective_to;
        -- 注意：这里只是警告，不是错误，允许设置历史配置
    END IF;
    
    RETURN NEW;
END;
$$;


ALTER FUNCTION data.validate_config_effective_period() OWNER TO geohuz;

--
-- Name: validate_config_schema(); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.validate_config_schema() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_schema JSONB;
BEGIN
    -- Schema验证保障 `validate_config_schema`
    -- 获取配置类型的schema定义
    SELECT value_schema INTO v_schema
    FROM data.config_types
    WHERE type_name = NEW.config_type;
    
    -- 如果定义了schema，验证配置值
    IF v_schema IS NOT NULL AND v_schema != '{}'::JSONB THEN
        -- 基础类型验证
        IF v_schema->>'type' = 'object' AND jsonb_typeof(NEW.config_value) != 'object' THEN
            RAISE EXCEPTION '配置类型"%s"要求配置值为JSON对象，实际为: %', 
                NEW.config_type, jsonb_typeof(NEW.config_value);
        END IF;
        
        -- 可以扩展更多验证规则
        -- 如：必需字段、数值范围、枚举值等
    END IF;
    
    RETURN NEW;
END;
$$;


ALTER FUNCTION data.validate_config_schema() OWNER TO geohuz;

--
-- Name: virtual_key_trigger_func(); Type: FUNCTION; Schema: data; Owner: geohuz
--

CREATE FUNCTION data.virtual_key_trigger_func() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    new_computed jsonb;
BEGIN
    -- 如果 primary_config_node_id 改变
    IF TG_OP = 'UPDATE' AND (OLD.primary_config_node_id IS DISTINCT FROM NEW.primary_config_node_id) THEN
        -- 删除这个 virtual_key_id 的所有映射（因为是一对一关系）
        DELETE FROM data.node_virtual_key_map WHERE virtual_key_id = NEW.id;
        
        -- 如果新的 node_id 不为空，插入新映射
        IF NEW.primary_config_node_id IS NOT NULL THEN
            INSERT INTO data.node_virtual_key_map(node_id, virtual_key_id)
            VALUES (NEW.primary_config_node_id, NEW.id);
        END IF;
    END IF;

    -- 刷新 computed_config
    new_computed := data.refresh_virtual_key_computed_config(NEW.id);
    NEW.computed_config := new_computed;

    -- 通知 Node.js 缓存失效
    PERFORM pg_notify('virtual_key_config_changed', NEW.id::text);

    RETURN NEW;
END;
$$;


ALTER FUNCTION data.virtual_key_trigger_func() OWNER TO geohuz;

--
-- Name: calculate_usage_cost(text, text, integer, integer, integer); Type: FUNCTION; Schema: internal; Owner: geohuz
--

CREATE FUNCTION internal.calculate_usage_cost(p_provider text, p_model text, p_input_tokens integer DEFAULT 0, p_output_tokens integer DEFAULT 0, p_requests integer DEFAULT 1) RETURNS numeric
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'data'
    AS $$
    SELECT 
        CASE 
            -- 按token计费
            WHEN pricing_model = 'per_token' THEN
                (p_input_tokens * price_per_input_token) +
                (p_output_tokens * price_per_output_token)
            -- 按请求计费
            WHEN pricing_model = 'per_request' THEN
                p_requests * price_per_request
            -- 混合计费
            WHEN pricing_model = 'hybrid' THEN
                (p_input_tokens * price_per_input_token) +
                (p_output_tokens * price_per_output_token) +
                (p_requests * price_per_request)
            -- 默认按token计费
            ELSE
                (p_input_tokens * price_per_input_token) +
                (p_output_tokens * price_per_output_token)
        END as total_cost
    FROM api.current_provider_rates
    WHERE provider = p_provider AND model = p_model;
$$;


ALTER FUNCTION internal.calculate_usage_cost(p_provider text, p_model text, p_input_tokens integer, p_output_tokens integer, p_requests integer) OWNER TO geohuz;

--
-- Name: change_user_status(uuid, text, uuid); Type: FUNCTION; Schema: internal; Owner: geohuz
--

CREATE FUNCTION internal.change_user_status(p_user_id uuid, p_new_status text, p_changed_by uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_old_status TEXT;
    v_status_log_id UUID;
BEGIN
    -- 🆕 添加行级锁，防止并发状态变更
    SELECT status INTO v_old_status
    FROM data.user_profile 
    WHERE user_id = p_user_id
    FOR UPDATE;  -- 🟢 关键：锁定用户记录
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User not found: %', p_user_id;
    END IF;
    
    -- 🆕 添加幂等性检查
    IF v_old_status = p_new_status THEN
        RETURN NULL;  -- 状态没变化，直接返回
    END IF;
    
    -- 更新用户状态
    UPDATE data.user_profile 
    SET status = p_new_status,
        canceled_at = CASE 
            WHEN p_new_status = 'canceled' THEN NOW() 
            ELSE canceled_at 
        END
    WHERE user_id = p_user_id;
    
    -- 记录状态变更日志
    INSERT INTO data.user_status_log (
        user_id, old_status, new_status, changed_at
    ) VALUES (
        p_user_id, v_old_status, p_new_status, NOW()
    ) RETURNING id INTO v_status_log_id;
    
    RETURN v_status_log_id;
END;
$$;


ALTER FUNCTION internal.change_user_status(p_user_id uuid, p_new_status text, p_changed_by uuid) OWNER TO geohuz;

--
-- Name: complete_user_registration(uuid); Type: FUNCTION; Schema: internal; Owner: geohuz
--

CREATE FUNCTION internal.complete_user_registration(p_user_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'data'
    AS $$
BEGIN
    -- 确保用户状态为 pending
    UPDATE user_profile 
    SET status = 'pending'
    WHERE user_id = p_user_id;
    
    -- 记录状态变更日志（从 null -> pending）
    INSERT INTO user_status_log (user_id, old_status, new_status, changed_at)
    VALUES (p_user_id, NULL, 'pending', NOW());
    
    -- 初始化账户余额
    INSERT INTO account_balance (user_id, balance, overdue_amount)
    VALUES (p_user_id, 0, 0)
    ON CONFLICT (user_id) DO NOTHING;
END;
$$;


ALTER FUNCTION internal.complete_user_registration(p_user_id uuid) OWNER TO geohuz;

--
-- Name: get_config_value(text, text); Type: FUNCTION; Schema: internal; Owner: geohuz
--

CREATE FUNCTION internal.get_config_value(p_key text, p_default text DEFAULT NULL::text) RETURNS text
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'internal'
    AS $$
    SELECT COALESCE(
        (SELECT config_value FROM system_config WHERE config_key = p_key AND is_active = true),
        p_default
    );
$$;


ALTER FUNCTION internal.get_config_value(p_key text, p_default text) OWNER TO geohuz;

--
-- Name: get_numeric_config(text, numeric); Type: FUNCTION; Schema: internal; Owner: geohuz
--

CREATE FUNCTION internal.get_numeric_config(p_key text, p_default numeric DEFAULT 0) RETURNS numeric
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'internal'
    AS $$
    SELECT COALESCE(
        (SELECT config_value::NUMERIC FROM system_config WHERE config_key = p_key AND is_active = true),
        p_default
    );
$$;


ALTER FUNCTION internal.get_numeric_config(p_key text, p_default numeric) OWNER TO geohuz;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account_balance; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.account_balance (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_userid uuid,
    balance numeric DEFAULT 0,
    overdue_amount numeric DEFAULT 0,
    owner_tenantid uuid
);


ALTER TABLE data.account_balance OWNER TO geohuz;

--
-- Name: account_balances; Type: VIEW; Schema: api; Owner: api_views_owner
--

CREATE VIEW api.account_balances AS
 SELECT id,
    owner_userid,
    balance,
    overdue_amount,
    owner_tenantid
   FROM data.account_balance;


ALTER VIEW api.account_balances OWNER TO api_views_owner;

--
-- Name: portkey_configs; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.portkey_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid,
    config_name text NOT NULL,
    config_json jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    effective_from timestamp with time zone NOT NULL,
    effective_to timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    notes text
);


ALTER TABLE data.portkey_configs OWNER TO geohuz;

--
-- Name: tenant; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.tenant (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    contact text,
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    default_template_id uuid,
    customer_type_id uuid
);


ALTER TABLE data.tenant OWNER TO geohuz;

--
-- Name: user_profile; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.user_profile (
    user_id uuid NOT NULL,
    username text NOT NULL,
    tenant_id uuid,
    status text DEFAULT 'pending'::text,
    created_at timestamp with time zone DEFAULT now(),
    canceled_at timestamp with time zone,
    customer_type_id uuid
);


ALTER TABLE data.user_profile OWNER TO geohuz;

--
-- Name: active_portkey_configs; Type: VIEW; Schema: api; Owner: geohuz
--

CREATE VIEW api.active_portkey_configs AS
 SELECT pc.id,
    pc.tenant_id,
    pc.user_id,
    pc.config_name,
    pc.config_json,
    pc.version,
    t.name AS tenant_name,
    up.username
   FROM ((data.portkey_configs pc
     LEFT JOIN data.tenant t ON ((pc.tenant_id = t.id)))
     LEFT JOIN data.user_profile up ON ((pc.user_id = up.user_id)))
  WHERE (pc.is_active = true);


ALTER VIEW api.active_portkey_configs OWNER TO geohuz;

--
-- Name: audit_log; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.audit_log (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT audit_logs_id_not_null NOT NULL,
    actor_id uuid,
    action text CONSTRAINT audit_logs_action_not_null NOT NULL,
    target_type text,
    target_id uuid,
    detail jsonb,
    ip_address text,
    user_agent text,
    created_at timestamp without time zone DEFAULT now()
);


ALTER TABLE data.audit_log OWNER TO geohuz;

--
-- Name: audit_logs; Type: VIEW; Schema: api; Owner: api_views_owner
--

CREATE VIEW api.audit_logs AS
 SELECT id,
    actor_id,
    action,
    target_type,
    target_id,
    detail,
    ip_address,
    user_agent,
    created_at
   FROM data.audit_log;


ALTER VIEW api.audit_logs OWNER TO api_views_owner;

--
-- Name: virtual_key; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.virtual_key (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    virtual_key text NOT NULL,
    name text NOT NULL,
    description text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    key_type_id uuid,
    key_prefix text,
    primary_config_node_id uuid,
    config_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    computed_config jsonb
);


ALTER TABLE data.virtual_key OWNER TO geohuz;

--
-- Name: billing_accounts; Type: VIEW; Schema: api; Owner: geohuz
--

CREATE VIEW api.billing_accounts AS
 SELECT vk.virtual_key,
    COALESCE(up.tenant_id, vk.user_id) AS account_id,
        CASE
            WHEN (up.tenant_id IS NOT NULL) THEN 'tenant'::text
            ELSE 'user'::text
        END AS account_type,
    ab.balance,
    ab.overdue_amount
   FROM ((data.virtual_key vk
     JOIN data.user_profile up ON ((up.user_id = vk.user_id)))
     JOIN data.account_balance ab ON (((ab.owner_userid = vk.user_id) OR (ab.owner_tenantid = up.tenant_id))));


ALTER VIEW api.billing_accounts OWNER TO geohuz;

--
-- Name: config_types; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.config_types (
    type_name text NOT NULL,
    display_name text NOT NULL,
    value_schema jsonb NOT NULL,
    default_value jsonb,
    merge_strategy text NOT NULL,
    description text,
    is_system_type boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    supports_tier_entitlements boolean DEFAULT true
);


ALTER TABLE data.config_types OWNER TO geohuz;

--
-- Name: config_types; Type: VIEW; Schema: api; Owner: api_views_owner
--

CREATE VIEW api.config_types AS
 SELECT type_name,
    display_name,
    value_schema,
    default_value,
    merge_strategy,
    description,
    is_system_type,
    created_at,
    supports_tier_entitlements
   FROM data.config_types;


ALTER VIEW api.config_types OWNER TO api_views_owner;

--
-- Name: provider_rate; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.provider_rate (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT provider_rates_id_not_null NOT NULL,
    provider text CONSTRAINT provider_rates_provider_not_null NOT NULL,
    model text CONSTRAINT provider_rates_model_not_null NOT NULL,
    price_per_token numeric,
    created_at timestamp with time zone DEFAULT now(),
    price_per_input_token numeric(12,8),
    price_per_output_token numeric(12,8),
    effective_from timestamp with time zone DEFAULT now(),
    effective_to timestamp with time zone,
    is_active boolean DEFAULT true,
    price_per_request numeric(12,8) DEFAULT 0,
    currency text DEFAULT 'usd'::text,
    pricing_model text DEFAULT 'per_token'::text,
    version integer DEFAULT 1,
    previous_version_id uuid,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now(),
    notes text
);


ALTER TABLE data.provider_rate OWNER TO geohuz;

--
-- Name: current_provider_rates; Type: VIEW; Schema: api; Owner: geohuz
--

CREATE VIEW api.current_provider_rates AS
 SELECT provider,
    model,
    COALESCE(price_per_input_token, price_per_token) AS price_per_input_token,
    COALESCE(price_per_output_token, price_per_token) AS price_per_output_token,
    COALESCE(price_per_request, (0)::numeric) AS price_per_request,
    COALESCE(pricing_model, 'per_token'::text) AS pricing_model,
    COALESCE(currency, 'usd'::text) AS currency,
    effective_from
   FROM data.provider_rate
  WHERE ((is_active = true) AND (effective_to IS NULL));


ALTER VIEW api.current_provider_rates OWNER TO geohuz;

--
-- Name: model_configs; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.model_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    model_name text NOT NULL,
    provider text NOT NULL,
    family text NOT NULL,
    portkey_target_name text,
    is_active boolean DEFAULT true,
    max_tokens integer DEFAULT 4000,
    supports_streaming boolean DEFAULT true,
    context_length integer DEFAULT 4096,
    description text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE data.model_configs OWNER TO geohuz;

--
-- Name: model_configs_view; Type: VIEW; Schema: api; Owner: geohuz
--

CREATE VIEW api.model_configs_view AS
 SELECT model_name,
    provider,
    family,
    portkey_target_name,
    max_tokens,
    supports_streaming,
    context_length,
    description,
    is_active
   FROM data.model_configs
  WHERE (is_active = true);


ALTER VIEW api.model_configs_view OWNER TO geohuz;

--
-- Name: portkey_config_history; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.portkey_config_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    config_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid,
    config_json jsonb NOT NULL,
    version integer NOT NULL,
    effective_from timestamp with time zone NOT NULL,
    effective_to timestamp with time zone,
    changed_by uuid NOT NULL,
    changed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    change_type text NOT NULL,
    notes text,
    CONSTRAINT portkey_config_history_change_type_check CHECK ((change_type = ANY (ARRAY['create'::text, 'update'::text, 'deactivate'::text])))
);


ALTER TABLE data.portkey_config_history OWNER TO geohuz;

--
-- Name: portkey_config_history_view; Type: VIEW; Schema: api; Owner: geohuz
--

CREATE VIEW api.portkey_config_history_view AS
 SELECT id,
    config_id,
    tenant_id,
    version,
    config_json,
    change_type,
    changed_at
   FROM data.portkey_config_history;


ALTER VIEW api.portkey_config_history_view OWNER TO geohuz;

--
-- Name: portkey_configs_view; Type: VIEW; Schema: api; Owner: geohuz
--

CREATE VIEW api.portkey_configs_view AS
 SELECT id,
    tenant_id,
    user_id,
    config_name,
    config_json,
    version,
    is_active,
    created_at,
    notes
   FROM data.portkey_configs
  WHERE (is_active = true);


ALTER VIEW api.portkey_configs_view OWNER TO geohuz;

--
-- Name: portkey_config_templates; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.portkey_config_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid,
    template_name text NOT NULL,
    template_json jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    is_global boolean DEFAULT false NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    notes text
);


ALTER TABLE data.portkey_config_templates OWNER TO geohuz;

--
-- Name: portkey_templates_view; Type: VIEW; Schema: api; Owner: geohuz
--

CREATE VIEW api.portkey_templates_view AS
 SELECT id,
    tenant_id,
    template_name,
    template_json,
    is_global,
    created_at
   FROM data.portkey_config_templates;


ALTER VIEW api.portkey_templates_view OWNER TO geohuz;

--
-- Name: provider_rate_history; Type: VIEW; Schema: api; Owner: geohuz
--

CREATE VIEW api.provider_rate_history AS
 SELECT provider,
    model,
    COALESCE(price_per_input_token, price_per_token) AS price_per_input_token,
    COALESCE(price_per_output_token, price_per_token) AS price_per_output_token,
    COALESCE(price_per_request, (0)::numeric) AS price_per_request,
    COALESCE(pricing_model, 'per_token'::text) AS pricing_model,
    COALESCE(currency, 'usd'::text) AS currency,
    effective_from,
    effective_to,
    is_active,
    version,
    notes,
    created_at
   FROM data.provider_rate
  ORDER BY provider, model, version DESC;


ALTER VIEW api.provider_rate_history OWNER TO geohuz;

--
-- Name: tenants; Type: VIEW; Schema: api; Owner: api_views_owner
--

CREATE VIEW api.tenants AS
 SELECT id,
    name,
    contact,
    notes,
    created_at
   FROM data.tenant;


ALTER VIEW api.tenants OWNER TO api_views_owner;

--
-- Name: tier_definitions; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.tier_definitions (
    tier_name text NOT NULL,
    display_name text NOT NULL,
    description text,
    pricing_model text DEFAULT 'monthly'::text,
    base_price numeric(10,4),
    currency text DEFAULT 'CNY'::text,
    is_public boolean DEFAULT true,
    is_active boolean DEFAULT true,
    display_order integer DEFAULT 1,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE data.tier_definitions OWNER TO geohuz;

--
-- Name: tier_feature_mappings; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.tier_feature_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tier_name text NOT NULL,
    config_type text NOT NULL,
    feature_value jsonb NOT NULL,
    is_default_for_tier boolean DEFAULT true,
    condition_expression jsonb,
    condition_description text,
    is_active boolean DEFAULT true,
    effective_from timestamp with time zone DEFAULT now(),
    effective_to timestamp with time zone
);


ALTER TABLE data.tier_feature_mappings OWNER TO geohuz;

--
-- Name: tier_feature_view; Type: VIEW; Schema: api; Owner: geohuz
--

CREATE VIEW api.tier_feature_view AS
 SELECT tfm.tier_name,
    tfm.config_type,
    tfm.feature_value,
    tfm.condition_expression,
    tfm.is_active,
    tfm.effective_from,
    tfm.effective_to,
    td.display_name AS tier_display,
    ct.display_name AS config_type_display
   FROM ((data.tier_feature_mappings tfm
     JOIN data.tier_definitions td ON ((tfm.tier_name = td.tier_name)))
     JOIN data.config_types ct ON ((tfm.config_type = ct.type_name)))
  WHERE ((tfm.is_active = true) AND ((tfm.effective_to IS NULL) OR (tfm.effective_to > now())));


ALTER VIEW api.tier_feature_view OWNER TO geohuz;

--
-- Name: topup_record; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.topup_record (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT topup_records_id_not_null NOT NULL,
    user_id uuid CONSTRAINT topup_records_user_id_not_null NOT NULL,
    amount numeric CONSTRAINT topup_records_amount_not_null NOT NULL,
    currency text DEFAULT 'usd'::text,
    payment_provider text,
    payment_reference text,
    status text DEFAULT 'pending'::text CONSTRAINT topup_records_status_not_null NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    CONSTRAINT topup_records_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT topup_records_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'success'::text, 'failed'::text, 'refunded'::text])))
);


ALTER TABLE data.topup_record OWNER TO geohuz;

--
-- Name: topup_records; Type: VIEW; Schema: api; Owner: api_views_owner
--

CREATE VIEW api.topup_records AS
 SELECT id,
    user_id,
    amount,
    currency,
    payment_provider,
    payment_reference,
    status,
    created_at,
    updated_at
   FROM data.topup_record;


ALTER VIEW api.topup_records OWNER TO api_views_owner;

--
-- Name: usage_log; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.usage_log (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT usage_logs_id_not_null NOT NULL,
    user_id uuid,
    provider text CONSTRAINT usage_logs_provider_not_null NOT NULL,
    model text CONSTRAINT usage_logs_model_not_null NOT NULL,
    tokens_used integer CONSTRAINT usage_logs_tokens_used_not_null NOT NULL,
    cost numeric CONSTRAINT usage_logs_cost_not_null NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    latency_ms integer,
    input_tokens integer,
    output_tokens integer,
    prompt_hash text,
    config_id uuid,
    metadata_json jsonb
);


ALTER TABLE data.usage_log OWNER TO geohuz;

--
-- Name: usage_logs; Type: VIEW; Schema: api; Owner: api_views_owner
--

CREATE VIEW api.usage_logs AS
 SELECT id,
    user_id,
    provider,
    model,
    tokens_used,
    cost,
    created_at,
    latency_ms,
    input_tokens,
    output_tokens,
    prompt_hash
   FROM data.usage_log;


ALTER VIEW api.usage_logs OWNER TO api_views_owner;

--
-- Name: api_key; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.api_key (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT api_keys_id_not_null NOT NULL,
    login_id uuid,
    api_key text CONSTRAINT api_keys_api_key_not_null NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


ALTER TABLE data.api_key OWNER TO geohuz;

--
-- Name: user_api_keys; Type: VIEW; Schema: api; Owner: api_views_owner
--

CREATE VIEW api.user_api_keys AS
 SELECT id,
    login_id AS user_id,
    api_key,
    created_at
   FROM data.api_key;


ALTER VIEW api.user_api_keys OWNER TO api_views_owner;

--
-- Name: user_profiles; Type: VIEW; Schema: api; Owner: api_views_owner
--

CREATE VIEW api.user_profiles AS
 SELECT user_id,
    username,
    tenant_id,
    status,
    created_at,
    canceled_at
   FROM data.user_profile;


ALTER VIEW api.user_profiles OWNER TO api_views_owner;

--
-- Name: user_status_log; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.user_status_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    old_status text,
    new_status text,
    changed_at timestamp without time zone DEFAULT now()
);


ALTER TABLE data.user_status_log OWNER TO geohuz;

--
-- Name: user_status_logs; Type: VIEW; Schema: api; Owner: api_views_owner
--

CREATE VIEW api.user_status_logs AS
 SELECT id,
    user_id,
    old_status,
    new_status,
    changed_at
   FROM data.user_status_log;


ALTER VIEW api.user_status_logs OWNER TO api_views_owner;

--
-- Name: virtual_key_details; Type: VIEW; Schema: api; Owner: geohuz
--

CREATE VIEW api.virtual_key_details AS
 SELECT vk.id,
    vk.user_id,
    vk.virtual_key,
    vk.name,
    vk.description,
    vk.is_active,
    vk.created_at,
    vk.updated_at,
    up.username,
    up.status AS user_status,
    ab.balance,
    t.name AS tenant_name
   FROM (((data.virtual_key vk
     JOIN data.user_profile up ON ((vk.user_id = up.user_id)))
     LEFT JOIN data.account_balance ab ON ((vk.user_id = ab.owner_userid)))
     LEFT JOIN data.tenant t ON ((up.tenant_id = t.id)))
  WHERE (vk.is_active = true);


ALTER VIEW api.virtual_key_details OWNER TO geohuz;

--
-- Name: virtual_keys; Type: VIEW; Schema: api; Owner: api_views_owner
--

CREATE VIEW api.virtual_keys AS
 SELECT vk.id,
    vk.user_id,
    vk.virtual_key,
    vk.name,
    vk.description,
    vk.is_active,
    vk.created_at,
    vk.updated_at,
    up.username,
    up.tenant_id
   FROM (data.virtual_key vk
     JOIN data.user_profile up ON ((vk.user_id = up.user_id)));


ALTER VIEW api.virtual_keys OWNER TO api_views_owner;

--
-- Name: virtual_keys_by_customer_type; Type: VIEW; Schema: api; Owner: api_views_owner
--

CREATE VIEW api.virtual_keys_by_customer_type AS
 SELECT vk.virtual_key,
    COALESCE(t.customer_type_id, up.customer_type_id) AS customer_type_id
   FROM ((data.virtual_key vk
     JOIN data.user_profile up ON ((up.user_id = vk.user_id)))
     LEFT JOIN data.tenant t ON ((t.id = up.tenant_id)))
  WHERE (vk.is_active = true);


ALTER VIEW api.virtual_keys_by_customer_type OWNER TO api_views_owner;

--
-- Name: login; Type: TABLE; Schema: auth; Owner: geohuz
--

CREATE TABLE auth.login (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    hashed_password text NOT NULL,
    role text NOT NULL
);


ALTER TABLE auth.login OWNER TO geohuz;

--
-- Name: billing_event; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.billing_event (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT billing_events_id_not_null NOT NULL,
    user_id uuid CONSTRAINT billing_events_user_id_not_null NOT NULL,
    event_type text CONSTRAINT billing_events_event_type_not_null NOT NULL,
    amount numeric CONSTRAINT billing_events_amount_not_null NOT NULL,
    balance_after numeric CONSTRAINT billing_events_balance_after_not_null NOT NULL,
    reference_id uuid,
    reference_type text,
    description text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    CONSTRAINT billing_events_event_type_check CHECK ((event_type = ANY (ARRAY['debit'::text, 'credit'::text])))
);


ALTER TABLE data.billing_event OWNER TO geohuz;

--
-- Name: config_cache_status; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.config_cache_status (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    config_type text NOT NULL,
    config_id uuid NOT NULL,
    cache_key text NOT NULL,
    last_updated timestamp with time zone DEFAULT now(),
    cache_version integer DEFAULT 1
);


ALTER TABLE data.config_cache_status OWNER TO geohuz;

--
-- Name: config_levels; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.config_levels (
    level_name text NOT NULL,
    display_name text NOT NULL,
    parent_level text,
    inherit_priority integer NOT NULL,
    description text,
    is_system_level boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE data.config_levels OWNER TO geohuz;

--
-- Name: config_nodes; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.config_nodes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    parent_id uuid,
    config_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    mount_policy text DEFAULT 'leaf_only'::text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    computed_config jsonb,
    is_dirty boolean DEFAULT false,
    CONSTRAINT config_nodes_mount_policy_check CHECK ((mount_policy = ANY (ARRAY['leaf_only'::text, 'any_node'::text, 'none'::text])))
);


ALTER TABLE data.config_nodes OWNER TO geohuz;

--
-- Name: customer_type; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.customer_type (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    notes text
);


ALTER TABLE data.customer_type OWNER TO geohuz;

--
-- Name: customer_type_rate; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.customer_type_rate (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT customer_rates_id_not_null NOT NULL,
    customer_type_id uuid CONSTRAINT customer_rates_customer_type_not_null NOT NULL,
    price_per_token numeric CONSTRAINT customer_rates_price_per_token_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    provider_rate_id uuid CONSTRAINT customer_rate_provider_rate_id_not_null NOT NULL,
    price_per_input_token numeric,
    price_per_output_token numeric
);


ALTER TABLE data.customer_type_rate OWNER TO geohuz;

--
-- Name: gateway_routes; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.gateway_routes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    route_path text NOT NULL,
    method text DEFAULT 'POST'::text,
    requires_virtual_key boolean DEFAULT true,
    config_template_id uuid,
    rate_limit_rpm integer DEFAULT 1000,
    rate_limit_tpm integer DEFAULT 100000,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE data.gateway_routes OWNER TO geohuz;

--
-- Name: inheritance_rules; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.inheritance_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    parent_level text NOT NULL,
    child_level text NOT NULL,
    config_type text NOT NULL,
    is_inheritance_enabled boolean DEFAULT true,
    custom_merge_strategy text,
    conflict_resolution text DEFAULT 'child_wins'::text,
    condition_expression jsonb,
    condition_description text,
    is_active boolean DEFAULT true,
    effective_from timestamp with time zone DEFAULT now(),
    effective_to timestamp with time zone
);


ALTER TABLE data.inheritance_rules OWNER TO geohuz;

--
-- Name: merge_strategies; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.merge_strategies (
    strategy_name text NOT NULL,
    description text NOT NULL,
    implementation_function text,
    is_builtin boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE data.merge_strategies OWNER TO geohuz;

--
-- Name: node_virtual_key_map; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.node_virtual_key_map (
    node_id uuid NOT NULL,
    virtual_key_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE data.node_virtual_key_map OWNER TO geohuz;

--
-- Name: provider_call_log; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.provider_call_log (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT provider_call_logs_id_not_null NOT NULL,
    user_id uuid,
    provider text CONSTRAINT provider_call_logs_provider_not_null NOT NULL,
    model text,
    request_payload jsonb,
    response_payload jsonb,
    latency_ms integer,
    status_code integer DEFAULT 0 CONSTRAINT provider_call_logs_status_code_not_null NOT NULL,
    provider_request_id text,
    created_at timestamp without time zone DEFAULT now()
);


ALTER TABLE data.provider_call_log OWNER TO geohuz;

--
-- Name: rate_limit; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.rate_limit (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT rate_limits_id_not_null NOT NULL,
    scope text CONSTRAINT rate_limits_scope_not_null NOT NULL,
    scope_id uuid,
    window_seconds integer CONSTRAINT rate_limits_window_seconds_not_null NOT NULL,
    max_requests integer CONSTRAINT rate_limits_max_requests_not_null NOT NULL,
    max_tokens integer,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    CONSTRAINT rate_limits_scope_check CHECK ((scope = ANY (ARRAY['user'::text, 'tenant'::text, 'global'::text]))),
    CONSTRAINT rate_limits_scopeid_check CHECK ((((scope = 'global'::text) AND (scope_id IS NULL)) OR ((scope = ANY (ARRAY['user'::text, 'tenant'::text])) AND (scope_id IS NOT NULL))))
);


ALTER TABLE data.rate_limit OWNER TO geohuz;

--
-- Name: virtual_key_usage; Type: TABLE; Schema: data; Owner: geohuz
--

CREATE TABLE data.virtual_key_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    virtual_key text NOT NULL,
    user_id uuid NOT NULL,
    request_count integer DEFAULT 0,
    token_count integer DEFAULT 0,
    last_used timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE data.virtual_key_usage OWNER TO geohuz;

--
-- Name: system_config; Type: TABLE; Schema: internal; Owner: geohuz
--

CREATE TABLE internal.system_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    config_key text NOT NULL,
    config_value text NOT NULL,
    data_type text DEFAULT 'text'::text,
    description text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE internal.system_config OWNER TO geohuz;

--
-- Name: login login_email_key; Type: CONSTRAINT; Schema: auth; Owner: geohuz
--

ALTER TABLE ONLY auth.login
    ADD CONSTRAINT login_email_key UNIQUE (email);


--
-- Name: login login_pkey; Type: CONSTRAINT; Schema: auth; Owner: geohuz
--

ALTER TABLE ONLY auth.login
    ADD CONSTRAINT login_pkey PRIMARY KEY (id);


--
-- Name: account_balance account_balance_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.account_balance
    ADD CONSTRAINT account_balance_pkey PRIMARY KEY (id);


--
-- Name: account_balance account_balance_user_id_unique; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.account_balance
    ADD CONSTRAINT account_balance_user_id_unique UNIQUE (owner_userid);


--
-- Name: api_key api_keys_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.api_key
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_logs_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.audit_log
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: billing_event billing_events_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.billing_event
    ADD CONSTRAINT billing_events_pkey PRIMARY KEY (id);


--
-- Name: config_cache_status config_cache_status_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.config_cache_status
    ADD CONSTRAINT config_cache_status_pkey PRIMARY KEY (id);


--
-- Name: config_levels config_levels_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.config_levels
    ADD CONSTRAINT config_levels_pkey PRIMARY KEY (level_name);


--
-- Name: config_nodes config_nodes_name_key; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.config_nodes
    ADD CONSTRAINT config_nodes_name_key UNIQUE (name);


--
-- Name: config_nodes config_nodes_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.config_nodes
    ADD CONSTRAINT config_nodes_pkey PRIMARY KEY (id);


--
-- Name: config_types config_types_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.config_types
    ADD CONSTRAINT config_types_pkey PRIMARY KEY (type_name);


--
-- Name: customer_type_rate customer_rates_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.customer_type_rate
    ADD CONSTRAINT customer_rates_pkey PRIMARY KEY (id);


--
-- Name: customer_type customer_type_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.customer_type
    ADD CONSTRAINT customer_type_pkey PRIMARY KEY (id);


--
-- Name: gateway_routes gateway_routes_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.gateway_routes
    ADD CONSTRAINT gateway_routes_pkey PRIMARY KEY (id);


--
-- Name: inheritance_rules inheritance_rules_parent_level_child_level_config_type_key; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.inheritance_rules
    ADD CONSTRAINT inheritance_rules_parent_level_child_level_config_type_key UNIQUE (parent_level, child_level, config_type);


--
-- Name: inheritance_rules inheritance_rules_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.inheritance_rules
    ADD CONSTRAINT inheritance_rules_pkey PRIMARY KEY (id);


--
-- Name: merge_strategies merge_strategies_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.merge_strategies
    ADD CONSTRAINT merge_strategies_pkey PRIMARY KEY (strategy_name);


--
-- Name: model_configs model_configs_model_name_key; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.model_configs
    ADD CONSTRAINT model_configs_model_name_key UNIQUE (model_name);


--
-- Name: model_configs model_configs_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.model_configs
    ADD CONSTRAINT model_configs_pkey PRIMARY KEY (id);


--
-- Name: node_virtual_key_map node_virtual_key_map_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.node_virtual_key_map
    ADD CONSTRAINT node_virtual_key_map_pkey PRIMARY KEY (node_id, virtual_key_id);


--
-- Name: portkey_config_history portkey_config_history_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.portkey_config_history
    ADD CONSTRAINT portkey_config_history_pkey PRIMARY KEY (id);


--
-- Name: portkey_config_templates portkey_config_templates_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.portkey_config_templates
    ADD CONSTRAINT portkey_config_templates_pkey PRIMARY KEY (id);


--
-- Name: portkey_configs portkey_configs_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.portkey_configs
    ADD CONSTRAINT portkey_configs_pkey PRIMARY KEY (id);


--
-- Name: provider_call_log provider_call_logs_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.provider_call_log
    ADD CONSTRAINT provider_call_logs_pkey PRIMARY KEY (id);


--
-- Name: provider_rate provider_rates_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.provider_rate
    ADD CONSTRAINT provider_rates_pkey PRIMARY KEY (id);


--
-- Name: rate_limit rate_limits_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.rate_limit
    ADD CONSTRAINT rate_limits_pkey PRIMARY KEY (id);


--
-- Name: tenant tenant_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.tenant
    ADD CONSTRAINT tenant_pkey PRIMARY KEY (id);


--
-- Name: tier_definitions tier_definitions_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.tier_definitions
    ADD CONSTRAINT tier_definitions_pkey PRIMARY KEY (tier_name);


--
-- Name: tier_feature_mappings tier_feature_mappings_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.tier_feature_mappings
    ADD CONSTRAINT tier_feature_mappings_pkey PRIMARY KEY (id);


--
-- Name: topup_record topup_records_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.topup_record
    ADD CONSTRAINT topup_records_pkey PRIMARY KEY (id);


--
-- Name: api_key uniq_login_id; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.api_key
    ADD CONSTRAINT uniq_login_id UNIQUE (login_id);


--
-- Name: usage_log usage_logs_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.usage_log
    ADD CONSTRAINT usage_logs_pkey PRIMARY KEY (id);


--
-- Name: user_profile user_profile_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.user_profile
    ADD CONSTRAINT user_profile_pkey PRIMARY KEY (user_id);


--
-- Name: user_profile user_profile_username_key; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.user_profile
    ADD CONSTRAINT user_profile_username_key UNIQUE (username);


--
-- Name: user_status_log user_status_log_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.user_status_log
    ADD CONSTRAINT user_status_log_pkey PRIMARY KEY (id);


--
-- Name: virtual_key virtual_key_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.virtual_key
    ADD CONSTRAINT virtual_key_pkey PRIMARY KEY (id);


--
-- Name: virtual_key_usage virtual_key_usage_pkey; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.virtual_key_usage
    ADD CONSTRAINT virtual_key_usage_pkey PRIMARY KEY (id);


--
-- Name: virtual_key virtual_key_virtual_key_key; Type: CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.virtual_key
    ADD CONSTRAINT virtual_key_virtual_key_key UNIQUE (virtual_key);


--
-- Name: system_config system_config_config_key_key; Type: CONSTRAINT; Schema: internal; Owner: geohuz
--

ALTER TABLE ONLY internal.system_config
    ADD CONSTRAINT system_config_config_key_key UNIQUE (config_key);


--
-- Name: system_config system_config_pkey; Type: CONSTRAINT; Schema: internal; Owner: geohuz
--

ALTER TABLE ONLY internal.system_config
    ADD CONSTRAINT system_config_pkey PRIMARY KEY (id);


--
-- Name: gin_portkey_configs_json; Type: INDEX; Schema: data; Owner: geohuz
--

CREATE INDEX gin_portkey_configs_json ON data.portkey_configs USING gin (config_json);


--
-- Name: gin_portkey_templates_json; Type: INDEX; Schema: data; Owner: geohuz
--

CREATE INDEX gin_portkey_templates_json ON data.portkey_config_templates USING gin (template_json);


--
-- Name: idx_config_nodes_active; Type: INDEX; Schema: data; Owner: geohuz
--

CREATE INDEX idx_config_nodes_active ON data.config_nodes USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_config_nodes_name; Type: INDEX; Schema: data; Owner: geohuz
--

CREATE INDEX idx_config_nodes_name ON data.config_nodes USING btree (name);


--
-- Name: idx_config_nodes_parent; Type: INDEX; Schema: data; Owner: geohuz
--

CREATE INDEX idx_config_nodes_parent ON data.config_nodes USING btree (parent_id) WHERE (parent_id IS NOT NULL);


--
-- Name: idx_model_configs_active; Type: INDEX; Schema: data; Owner: geohuz
--

CREATE INDEX idx_model_configs_active ON data.model_configs USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_model_configs_family; Type: INDEX; Schema: data; Owner: geohuz
--

CREATE INDEX idx_model_configs_family ON data.model_configs USING btree (family);


--
-- Name: idx_model_configs_provider; Type: INDEX; Schema: data; Owner: geohuz
--

CREATE INDEX idx_model_configs_provider ON data.model_configs USING btree (provider);


--
-- Name: idx_node_vk_map_node; Type: INDEX; Schema: data; Owner: geohuz
--

CREATE INDEX idx_node_vk_map_node ON data.node_virtual_key_map USING btree (node_id);


--
-- Name: idx_node_vk_map_vk; Type: INDEX; Schema: data; Owner: geohuz
--

CREATE INDEX idx_node_vk_map_vk ON data.node_virtual_key_map USING btree (virtual_key_id);


--
-- Name: idx_portkey_config_history_config_id; Type: INDEX; Schema: data; Owner: geohuz
--

CREATE INDEX idx_portkey_config_history_config_id ON data.portkey_config_history USING btree (config_id);


--
-- Name: idx_portkey_configs_tenant_user; Type: INDEX; Schema: data; Owner: geohuz
--

CREATE INDEX idx_portkey_configs_tenant_user ON data.portkey_configs USING btree (tenant_id, user_id);


--
-- Name: idx_portkey_templates_tenant; Type: INDEX; Schema: data; Owner: geohuz
--

CREATE INDEX idx_portkey_templates_tenant ON data.portkey_config_templates USING btree (tenant_id);


--
-- Name: tier_feature_mappings_unique; Type: INDEX; Schema: data; Owner: geohuz
--

CREATE UNIQUE INDEX tier_feature_mappings_unique ON data.tier_feature_mappings USING btree (tier_name, config_type, COALESCE(condition_expression, '{}'::jsonb));


--
-- Name: uniq_portkey_configs_name_version; Type: INDEX; Schema: data; Owner: geohuz
--

CREATE UNIQUE INDEX uniq_portkey_configs_name_version ON data.portkey_configs USING btree (tenant_id, user_id, config_name, version);


--
-- Name: uniq_portkey_templates_name_version; Type: INDEX; Schema: data; Owner: geohuz
--

CREATE UNIQUE INDEX uniq_portkey_templates_name_version ON data.portkey_config_templates USING btree (tenant_id, template_name, version);


--
-- Name: login encrypt_pass; Type: TRIGGER; Schema: auth; Owner: geohuz
--

CREATE TRIGGER encrypt_pass BEFORE INSERT OR UPDATE ON auth.login FOR EACH ROW EXECUTE FUNCTION auth.encrypt_pass();


--
-- Name: login ensure_user_role_exists; Type: TRIGGER; Schema: auth; Owner: geohuz
--

CREATE CONSTRAINT TRIGGER ensure_user_role_exists AFTER INSERT OR UPDATE ON auth.login NOT DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION auth.check_role_exists();


--
-- Name: config_levels config_levels_notify; Type: TRIGGER; Schema: data; Owner: geohuz
--

CREATE TRIGGER config_levels_notify AFTER INSERT OR DELETE OR UPDATE ON data.config_levels FOR EACH ROW EXECUTE FUNCTION data.notify_config_change();


--
-- Name: config_types config_types_notify; Type: TRIGGER; Schema: data; Owner: geohuz
--

CREATE TRIGGER config_types_notify AFTER INSERT OR DELETE OR UPDATE ON data.config_types FOR EACH ROW EXECUTE FUNCTION data.notify_config_change();


--
-- Name: inheritance_rules inheritance_rules_notify; Type: TRIGGER; Schema: data; Owner: geohuz
--

CREATE TRIGGER inheritance_rules_notify AFTER INSERT OR DELETE OR UPDATE ON data.inheritance_rules FOR EACH ROW EXECUTE FUNCTION data.notify_config_change();


--
-- Name: config_nodes notify_node_changed_trigger; Type: TRIGGER; Schema: data; Owner: geohuz
--

CREATE TRIGGER notify_node_changed_trigger AFTER UPDATE OF config_data, parent_id ON data.config_nodes FOR EACH ROW EXECUTE FUNCTION data.notify_node_changed();


--
-- Name: inheritance_rules prevent_inheritance_cycle_trigger; Type: TRIGGER; Schema: data; Owner: geohuz
--

CREATE TRIGGER prevent_inheritance_cycle_trigger BEFORE INSERT OR UPDATE ON data.inheritance_rules FOR EACH ROW EXECUTE FUNCTION data.prevent_inheritance_cycle();


--
-- Name: tier_feature_mappings prevent_unsupported_tier_features_trigger; Type: TRIGGER; Schema: data; Owner: geohuz
--

CREATE TRIGGER prevent_unsupported_tier_features_trigger BEFORE INSERT OR UPDATE ON data.tier_feature_mappings FOR EACH ROW EXECUTE FUNCTION data.prevent_unsupported_tier_features();


--
-- Name: tier_feature_mappings tier_feature_mappings_notify; Type: TRIGGER; Schema: data; Owner: geohuz
--

CREATE TRIGGER tier_feature_mappings_notify AFTER INSERT OR DELETE OR UPDATE ON data.tier_feature_mappings FOR EACH ROW EXECUTE FUNCTION data.notify_config_change();


--
-- Name: account_balance trg_account_balance_notify; Type: TRIGGER; Schema: data; Owner: geohuz
--

CREATE TRIGGER trg_account_balance_notify AFTER INSERT OR UPDATE OF balance, overdue_amount ON data.account_balance FOR EACH ROW EXECUTE FUNCTION data.notify_account_balance_update();


--
-- Name: customer_type_rate trg_customer_type_rate_update; Type: TRIGGER; Schema: data; Owner: geohuz
--

CREATE TRIGGER trg_customer_type_rate_update AFTER INSERT OR DELETE OR UPDATE ON data.customer_type_rate FOR EACH ROW EXECUTE FUNCTION data.notify_customer_type_rate_update();


--
-- Name: config_nodes trg_refresh_node; Type: TRIGGER; Schema: data; Owner: geohuz
--

CREATE TRIGGER trg_refresh_node AFTER INSERT OR UPDATE OF config_data, parent_id ON data.config_nodes FOR EACH ROW EXECUTE FUNCTION data.on_node_change();


--
-- Name: virtual_key trg_virtual_key; Type: TRIGGER; Schema: data; Owner: geohuz
--

CREATE TRIGGER trg_virtual_key AFTER INSERT OR UPDATE OF primary_config_node_id, config_data ON data.virtual_key FOR EACH ROW EXECUTE FUNCTION data.virtual_key_trigger_func();


--
-- Name: portkey_configs update_portkey_configs_timestamp; Type: TRIGGER; Schema: data; Owner: geohuz
--

CREATE TRIGGER update_portkey_configs_timestamp BEFORE UPDATE ON data.portkey_configs FOR EACH ROW EXECUTE FUNCTION data.update_timestamp();


--
-- Name: portkey_config_templates update_portkey_templates_timestamp; Type: TRIGGER; Schema: data; Owner: geohuz
--

CREATE TRIGGER update_portkey_templates_timestamp BEFORE UPDATE ON data.portkey_config_templates FOR EACH ROW EXECUTE FUNCTION data.update_timestamp();


--
-- Name: account_balance account_balance_owner_id_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.account_balance
    ADD CONSTRAINT account_balance_owner_id_fkey FOREIGN KEY (owner_tenantid) REFERENCES data.tenant(id);


--
-- Name: account_balance account_balance_owner_user_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.account_balance
    ADD CONSTRAINT account_balance_owner_user_fkey FOREIGN KEY (owner_userid) REFERENCES data.user_profile(user_id);


--
-- Name: config_levels config_levels_parent_level_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.config_levels
    ADD CONSTRAINT config_levels_parent_level_fkey FOREIGN KEY (parent_level) REFERENCES data.config_levels(level_name);


--
-- Name: config_nodes config_nodes_parent_id_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.config_nodes
    ADD CONSTRAINT config_nodes_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES data.config_nodes(id) ON DELETE CASCADE;


--
-- Name: customer_type_rate customer_rate_provider_rate_id_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.customer_type_rate
    ADD CONSTRAINT customer_rate_provider_rate_id_fkey FOREIGN KEY (provider_rate_id) REFERENCES data.provider_rate(id);


--
-- Name: customer_type_rate customer_type_rate_customer_type_id_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.customer_type_rate
    ADD CONSTRAINT customer_type_rate_customer_type_id_fkey FOREIGN KEY (customer_type_id) REFERENCES data.customer_type(id);


--
-- Name: billing_event fk_billing_user; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.billing_event
    ADD CONSTRAINT fk_billing_user FOREIGN KEY (user_id) REFERENCES auth.login(id);


--
-- Name: topup_record fk_topup_user; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.topup_record
    ADD CONSTRAINT fk_topup_user FOREIGN KEY (user_id) REFERENCES auth.login(id);


--
-- Name: gateway_routes gateway_routes_config_template_id_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.gateway_routes
    ADD CONSTRAINT gateway_routes_config_template_id_fkey FOREIGN KEY (config_template_id) REFERENCES data.portkey_config_templates(id);


--
-- Name: inheritance_rules inheritance_rules_child_level_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.inheritance_rules
    ADD CONSTRAINT inheritance_rules_child_level_fkey FOREIGN KEY (child_level) REFERENCES data.config_levels(level_name);


--
-- Name: inheritance_rules inheritance_rules_config_type_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.inheritance_rules
    ADD CONSTRAINT inheritance_rules_config_type_fkey FOREIGN KEY (config_type) REFERENCES data.config_types(type_name);


--
-- Name: inheritance_rules inheritance_rules_custom_merge_strategy_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.inheritance_rules
    ADD CONSTRAINT inheritance_rules_custom_merge_strategy_fkey FOREIGN KEY (custom_merge_strategy) REFERENCES data.merge_strategies(strategy_name);


--
-- Name: inheritance_rules inheritance_rules_parent_level_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.inheritance_rules
    ADD CONSTRAINT inheritance_rules_parent_level_fkey FOREIGN KEY (parent_level) REFERENCES data.config_levels(level_name);


--
-- Name: node_virtual_key_map node_virtual_key_map_node_id_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.node_virtual_key_map
    ADD CONSTRAINT node_virtual_key_map_node_id_fkey FOREIGN KEY (node_id) REFERENCES data.config_nodes(id) ON DELETE CASCADE;


--
-- Name: node_virtual_key_map node_virtual_key_map_virtual_key_id_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.node_virtual_key_map
    ADD CONSTRAINT node_virtual_key_map_virtual_key_id_fkey FOREIGN KEY (virtual_key_id) REFERENCES data.virtual_key(id) ON DELETE CASCADE;


--
-- Name: portkey_config_history portkey_config_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.portkey_config_history
    ADD CONSTRAINT portkey_config_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES auth.login(id);


--
-- Name: portkey_config_history portkey_config_history_config_id_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.portkey_config_history
    ADD CONSTRAINT portkey_config_history_config_id_fkey FOREIGN KEY (config_id) REFERENCES data.portkey_configs(id) ON DELETE CASCADE;


--
-- Name: portkey_config_templates portkey_config_templates_created_by_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.portkey_config_templates
    ADD CONSTRAINT portkey_config_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.login(id);


--
-- Name: portkey_config_templates portkey_config_templates_tenant_id_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.portkey_config_templates
    ADD CONSTRAINT portkey_config_templates_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES data.tenant(id) ON DELETE CASCADE;


--
-- Name: portkey_configs portkey_configs_created_by_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.portkey_configs
    ADD CONSTRAINT portkey_configs_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.login(id);


--
-- Name: portkey_configs portkey_configs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.portkey_configs
    ADD CONSTRAINT portkey_configs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES data.tenant(id) ON DELETE CASCADE;


--
-- Name: portkey_configs portkey_configs_user_id_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.portkey_configs
    ADD CONSTRAINT portkey_configs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.login(id) ON DELETE CASCADE;


--
-- Name: provider_rate provider_rate_previous_version_id_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.provider_rate
    ADD CONSTRAINT provider_rate_previous_version_id_fkey FOREIGN KEY (previous_version_id) REFERENCES data.provider_rate(id);


--
-- Name: tenant tenant_customer_type_id_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.tenant
    ADD CONSTRAINT tenant_customer_type_id_fkey FOREIGN KEY (customer_type_id) REFERENCES data.customer_type(id);


--
-- Name: tier_feature_mappings tier_feature_mappings_config_type_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.tier_feature_mappings
    ADD CONSTRAINT tier_feature_mappings_config_type_fkey FOREIGN KEY (config_type) REFERENCES data.config_types(type_name);


--
-- Name: tier_feature_mappings tier_feature_mappings_tier_name_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.tier_feature_mappings
    ADD CONSTRAINT tier_feature_mappings_tier_name_fkey FOREIGN KEY (tier_name) REFERENCES data.tier_definitions(tier_name);


--
-- Name: user_profile user_profile_customer_type_id_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.user_profile
    ADD CONSTRAINT user_profile_customer_type_id_fkey FOREIGN KEY (customer_type_id) REFERENCES data.customer_type(id);


--
-- Name: user_profile user_profile_tenant_id_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.user_profile
    ADD CONSTRAINT user_profile_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES data.tenant(id);


--
-- Name: user_profile user_profile_user_id_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.user_profile
    ADD CONSTRAINT user_profile_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.login(id);


--
-- Name: virtual_key virtual_key_primary_config_node_id_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.virtual_key
    ADD CONSTRAINT virtual_key_primary_config_node_id_fkey FOREIGN KEY (primary_config_node_id) REFERENCES data.config_nodes(id);


--
-- Name: virtual_key_usage virtual_key_usage_user_id_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.virtual_key_usage
    ADD CONSTRAINT virtual_key_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.login(id);


--
-- Name: virtual_key virtual_key_user_id_fkey; Type: FK CONSTRAINT; Schema: data; Owner: geohuz
--

ALTER TABLE ONLY data.virtual_key
    ADD CONSTRAINT virtual_key_user_id_fkey FOREIGN KEY (user_id) REFERENCES data.user_profile(user_id);


--
-- Name: account_balance; Type: ROW SECURITY; Schema: data; Owner: geohuz
--

ALTER TABLE data.account_balance ENABLE ROW LEVEL SECURITY;

--
-- Name: account_balance account_balance_access_for_user; Type: POLICY; Schema: data; Owner: geohuz
--

CREATE POLICY account_balance_access_for_user ON data.account_balance USING ((data.userid() = owner_userid));


--
-- Name: account_balance account_balance_sys_admin; Type: POLICY; Schema: data; Owner: geohuz
--

CREATE POLICY account_balance_sys_admin ON data.account_balance USING ((((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'sys_admin'::text));


--
-- Name: account_balance account_balance_tenant; Type: POLICY; Schema: data; Owner: geohuz
--

CREATE POLICY account_balance_tenant ON data.account_balance FOR SELECT USING (((((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'tenant_admin'::text) AND (owner_userid IN ( SELECT up.user_id
   FROM data.user_profile up
  WHERE (up.tenant_id = ( SELECT user_profile.tenant_id
           FROM data.user_profile
          WHERE (user_profile.user_id = (((current_setting('request.jwt.claims'::text, true))::json ->> 'userid'::text))::uuid)))))));


--
-- Name: usage_log admin_access; Type: POLICY; Schema: data; Owner: geohuz
--

CREATE POLICY admin_access ON data.usage_log USING ((((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'sys_admin'::text));


--
-- Name: usage_log; Type: ROW SECURITY; Schema: data; Owner: geohuz
--

ALTER TABLE data.usage_log ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_log user_access; Type: POLICY; Schema: data; Owner: geohuz
--

CREATE POLICY user_access ON data.usage_log FOR SELECT USING ((user_id = (((current_setting('request.jwt.claims'::text, true))::json ->> 'userid'::text))::uuid));


--
-- Name: supabase_realtime; Type: PUBLICATION; Schema: -; Owner: geohuz
--

CREATE PUBLICATION supabase_realtime FOR ALL TABLES WITH (publish = 'insert, update, delete, truncate');


ALTER PUBLICATION supabase_realtime OWNER TO geohuz;

--
-- Name: supabase_realtime_messages_publication; Type: PUBLICATION; Schema: -; Owner: geohuz
--

CREATE PUBLICATION supabase_realtime_messages_publication WITH (publish = 'insert, update, delete, truncate');


ALTER PUBLICATION supabase_realtime_messages_publication OWNER TO geohuz;

--
-- Name: SCHEMA api; Type: ACL; Schema: -; Owner: geohuz
--

GRANT USAGE ON SCHEMA api TO anon;
GRANT USAGE ON SCHEMA api TO norm_user;
GRANT USAGE ON SCHEMA api TO sys_admin;
GRANT USAGE ON SCHEMA api TO tenant_admin;


--
-- Name: SCHEMA auth; Type: ACL; Schema: -; Owner: geohuz
--

GRANT USAGE ON SCHEMA auth TO api_views_owner;


--
-- Name: SCHEMA data; Type: ACL; Schema: -; Owner: geohuz
--

GRANT USAGE ON SCHEMA data TO sys_admin;


--
-- Name: FUNCTION activate_portkey_config(p_id uuid, p_reason text, p_activated_by uuid); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.activate_portkey_config(p_id uuid, p_reason text, p_activated_by uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION api.activate_portkey_config(p_id uuid, p_reason text, p_activated_by uuid) TO sys_admin;


--
-- Name: FUNCTION activate_virtual_key(p_virtual_key text, p_reason text); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.activate_virtual_key(p_virtual_key text, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION api.activate_virtual_key(p_virtual_key text, p_reason text) TO sys_admin;


--
-- Name: FUNCTION blacklist_user(p_user_id uuid, p_reason text); Type: ACL; Schema: api; Owner: geohuz
--

GRANT ALL ON FUNCTION api.blacklist_user(p_user_id uuid, p_reason text) TO sys_admin;


--
-- Name: FUNCTION cancel_user(p_user_id uuid, p_reason text); Type: ACL; Schema: api; Owner: geohuz
--

GRANT ALL ON FUNCTION api.cancel_user(p_user_id uuid, p_reason text) TO sys_admin;


--
-- Name: FUNCTION check_user_access(p_user_id uuid); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.check_user_access(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION api.check_user_access(p_user_id uuid) TO sys_admin;


--
-- Name: FUNCTION cleanup_test_data(); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.cleanup_test_data() FROM PUBLIC;
GRANT ALL ON FUNCTION api.cleanup_test_data() TO sys_admin;


--
-- Name: FUNCTION config_create(p_config_type text, p_level_name text, p_config_value jsonb, p_scope_id uuid, p_effective_from timestamp with time zone, p_effective_to timestamp with time zone); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.config_create(p_config_type text, p_level_name text, p_config_value jsonb, p_scope_id uuid, p_effective_from timestamp with time zone, p_effective_to timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION api.config_create(p_config_type text, p_level_name text, p_config_value jsonb, p_scope_id uuid, p_effective_from timestamp with time zone, p_effective_to timestamp with time zone) TO sys_admin;


--
-- Name: FUNCTION config_delete(p_config_type text, p_level_name text, p_scope_id uuid); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.config_delete(p_config_type text, p_level_name text, p_scope_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION api.config_delete(p_config_type text, p_level_name text, p_scope_id uuid) TO sys_admin;


--
-- Name: FUNCTION config_update(p_config_type text, p_level_name text, p_config_value jsonb, p_scope_id uuid, p_version_notes text); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.config_update(p_config_type text, p_level_name text, p_config_value jsonb, p_scope_id uuid, p_version_notes text) FROM PUBLIC;
GRANT ALL ON FUNCTION api.config_update(p_config_type text, p_level_name text, p_config_value jsonb, p_scope_id uuid, p_version_notes text) TO sys_admin;


--
-- Name: FUNCTION confirm_topup(p_topup_id uuid); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.confirm_topup(p_topup_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION api.confirm_topup(p_topup_id uuid) TO sys_admin;


--
-- Name: FUNCTION create_api_key(p_user_id uuid); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.create_api_key(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION api.create_api_key(p_user_id uuid) TO sys_admin;


--
-- Name: FUNCTION create_portkey_config(p_tenant_id uuid, p_user_id uuid, p_config_name text, p_config_json jsonb, p_effective_from timestamp with time zone, p_notes text, p_created_by uuid); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.create_portkey_config(p_tenant_id uuid, p_user_id uuid, p_config_name text, p_config_json jsonb, p_effective_from timestamp with time zone, p_notes text, p_created_by uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION api.create_portkey_config(p_tenant_id uuid, p_user_id uuid, p_config_name text, p_config_json jsonb, p_effective_from timestamp with time zone, p_notes text, p_created_by uuid) TO sys_admin;


--
-- Name: FUNCTION create_portkey_template(p_tenant_id uuid, p_template_name text, p_template_json jsonb, p_is_global boolean, p_notes text, p_created_by uuid); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.create_portkey_template(p_tenant_id uuid, p_template_name text, p_template_json jsonb, p_is_global boolean, p_notes text, p_created_by uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION api.create_portkey_template(p_tenant_id uuid, p_template_name text, p_template_json jsonb, p_is_global boolean, p_notes text, p_created_by uuid) TO sys_admin;


--
-- Name: FUNCTION deactivate_portkey_config(p_id uuid, p_reason text, p_deactivated_by uuid); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.deactivate_portkey_config(p_id uuid, p_reason text, p_deactivated_by uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION api.deactivate_portkey_config(p_id uuid, p_reason text, p_deactivated_by uuid) TO sys_admin;


--
-- Name: FUNCTION deactivate_virtual_key(p_virtual_key text, p_reason text); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.deactivate_virtual_key(p_virtual_key text, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION api.deactivate_virtual_key(p_virtual_key text, p_reason text) TO sys_admin;


--
-- Name: FUNCTION get_active_portkey_config(p_tenant_id uuid, p_user_id uuid); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.get_active_portkey_config(p_tenant_id uuid, p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION api.get_active_portkey_config(p_tenant_id uuid, p_user_id uuid) TO sys_admin;


--
-- Name: FUNCTION get_customer_type_pricing(p_customer_type_id uuid); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.get_customer_type_pricing(p_customer_type_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION api.get_customer_type_pricing(p_customer_type_id uuid) TO sys_admin;


--
-- Name: FUNCTION get_portkey_template(p_id uuid); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.get_portkey_template(p_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION api.get_portkey_template(p_id uuid) TO sys_admin;


--
-- Name: FUNCTION get_virtualkey_config(p_virtual_key text); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.get_virtualkey_config(p_virtual_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION api.get_virtualkey_config(p_virtual_key text) TO sys_admin;


--
-- Name: FUNCTION get_virtualkey_pricing(p_virtual_key text); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.get_virtualkey_pricing(p_virtual_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION api.get_virtualkey_pricing(p_virtual_key text) TO sys_admin;


--
-- Name: FUNCTION login(email text, pass text); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.login(email text, pass text) FROM PUBLIC;
GRANT ALL ON FUNCTION api.login(email text, pass text) TO anon;


--
-- Name: FUNCTION merge_portkey_configs(p_base_json jsonb, p_override_json jsonb); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.merge_portkey_configs(p_base_json jsonb, p_override_json jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION api.merge_portkey_configs(p_base_json jsonb, p_override_json jsonb) TO sys_admin;


--
-- Name: FUNCTION record_usage(p_user_id uuid, p_provider text, p_model text, p_input_tokens integer, p_output_tokens integer, p_cost numeric, p_prompt_hash text); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.record_usage(p_user_id uuid, p_provider text, p_model text, p_input_tokens integer, p_output_tokens integer, p_cost numeric, p_prompt_hash text) FROM PUBLIC;
GRANT ALL ON FUNCTION api.record_usage(p_user_id uuid, p_provider text, p_model text, p_input_tokens integer, p_output_tokens integer, p_cost numeric, p_prompt_hash text) TO sys_admin;


--
-- Name: FUNCTION resolve_dynamic_config(p_config_type text, p_target_level text, p_target_scope_id uuid, p_context jsonb); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.resolve_dynamic_config(p_config_type text, p_target_level text, p_target_scope_id uuid, p_context jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION api.resolve_dynamic_config(p_config_type text, p_target_level text, p_target_scope_id uuid, p_context jsonb) TO sys_admin;


--
-- Name: FUNCTION rotate_virtual_key(p_old_virtual_key text, p_reason text); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.rotate_virtual_key(p_old_virtual_key text, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION api.rotate_virtual_key(p_old_virtual_key text, p_reason text) TO sys_admin;


--
-- Name: FUNCTION setup_test_data(p_tenant_data jsonb, p_tenant_admin_data jsonb, p_normal_user_data jsonb, p_virtual_key_types jsonb); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.setup_test_data(p_tenant_data jsonb, p_tenant_admin_data jsonb, p_normal_user_data jsonb, p_virtual_key_types jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION api.setup_test_data(p_tenant_data jsonb, p_tenant_admin_data jsonb, p_normal_user_data jsonb, p_virtual_key_types jsonb) TO sys_admin;


--
-- Name: FUNCTION test_config_cleanup(p_user_id uuid); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.test_config_cleanup(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION api.test_config_cleanup(p_user_id uuid) TO sys_admin;


--
-- Name: FUNCTION tier_feature_set(p_tier_name text, p_config_type text, p_feature_value jsonb, p_condition_expression jsonb, p_is_active boolean); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.tier_feature_set(p_tier_name text, p_config_type text, p_feature_value jsonb, p_condition_expression jsonb, p_is_active boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION api.tier_feature_set(p_tier_name text, p_config_type text, p_feature_value jsonb, p_condition_expression jsonb, p_is_active boolean) TO sys_admin;


--
-- Name: FUNCTION topup_user(p_user_id uuid, p_amount numeric, p_payment_reference text, p_payment_provider text, p_currency text); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.topup_user(p_user_id uuid, p_amount numeric, p_payment_reference text, p_payment_provider text, p_currency text) FROM PUBLIC;
GRANT ALL ON FUNCTION api.topup_user(p_user_id uuid, p_amount numeric, p_payment_reference text, p_payment_provider text, p_currency text) TO sys_admin;


--
-- Name: FUNCTION unblacklist_user(p_user_id uuid, p_reason text); Type: ACL; Schema: api; Owner: geohuz
--

GRANT ALL ON FUNCTION api.unblacklist_user(p_user_id uuid, p_reason text) TO sys_admin;


--
-- Name: FUNCTION update_portkey_config(p_id uuid, p_config_json jsonb, p_effective_from timestamp with time zone, p_notes text, p_updated_by uuid); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.update_portkey_config(p_id uuid, p_config_json jsonb, p_effective_from timestamp with time zone, p_notes text, p_updated_by uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION api.update_portkey_config(p_id uuid, p_config_json jsonb, p_effective_from timestamp with time zone, p_notes text, p_updated_by uuid) TO sys_admin;


--
-- Name: FUNCTION update_provider_rate(p_provider text, p_model text, p_input_rate numeric, p_output_rate numeric, p_request_rate numeric, p_pricing_model text, p_currency text, p_effective_from timestamp with time zone, p_notes text, p_created_by uuid); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.update_provider_rate(p_provider text, p_model text, p_input_rate numeric, p_output_rate numeric, p_request_rate numeric, p_pricing_model text, p_currency text, p_effective_from timestamp with time zone, p_notes text, p_created_by uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION api.update_provider_rate(p_provider text, p_model text, p_input_rate numeric, p_output_rate numeric, p_request_rate numeric, p_pricing_model text, p_currency text, p_effective_from timestamp with time zone, p_notes text, p_created_by uuid) TO sys_admin;


--
-- Name: FUNCTION validate_portkey_config_json(p_json jsonb); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.validate_portkey_config_json(p_json jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION api.validate_portkey_config_json(p_json jsonb) TO sys_admin;


--
-- Name: FUNCTION virtual_config_resolve(p_virtual_key text, p_context jsonb); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.virtual_config_resolve(p_virtual_key text, p_context jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION api.virtual_config_resolve(p_virtual_key text, p_context jsonb) TO sys_admin;


--
-- Name: FUNCTION virtual_config_set(p_virtual_key text, p_config_type text, p_config_value jsonb); Type: ACL; Schema: api; Owner: geohuz
--

REVOKE ALL ON FUNCTION api.virtual_config_set(p_virtual_key text, p_config_type text, p_config_value jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION api.virtual_config_set(p_virtual_key text, p_config_type text, p_config_value jsonb) TO sys_admin;


--
-- Name: FUNCTION check_role_exists(); Type: ACL; Schema: auth; Owner: geohuz
--

REVOKE ALL ON FUNCTION auth.check_role_exists() FROM PUBLIC;


--
-- Name: FUNCTION encrypt_pass(); Type: ACL; Schema: auth; Owner: geohuz
--

REVOKE ALL ON FUNCTION auth.encrypt_pass() FROM PUBLIC;


--
-- Name: FUNCTION change_user_status(p_user_id uuid, p_new_status text, p_changed_by uuid); Type: ACL; Schema: internal; Owner: geohuz
--

REVOKE ALL ON FUNCTION internal.change_user_status(p_user_id uuid, p_new_status text, p_changed_by uuid) FROM PUBLIC;


--
-- Name: FUNCTION complete_user_registration(p_user_id uuid); Type: ACL; Schema: internal; Owner: geohuz
--

REVOKE ALL ON FUNCTION internal.complete_user_registration(p_user_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION get_config_value(p_key text, p_default text); Type: ACL; Schema: internal; Owner: geohuz
--

GRANT ALL ON FUNCTION internal.get_config_value(p_key text, p_default text) TO sys_admin;


--
-- Name: FUNCTION get_numeric_config(p_key text, p_default numeric); Type: ACL; Schema: internal; Owner: geohuz
--

GRANT ALL ON FUNCTION internal.get_numeric_config(p_key text, p_default numeric) TO sys_admin;


--
-- Name: TABLE account_balance; Type: ACL; Schema: data; Owner: geohuz
--

REVOKE ALL ON TABLE data.account_balance FROM geohuz;
GRANT ALL ON TABLE data.account_balance TO api_views_owner;


--
-- Name: TABLE account_balances; Type: ACL; Schema: api; Owner: api_views_owner
--

GRANT SELECT ON TABLE api.account_balances TO norm_user;
GRANT ALL ON TABLE api.account_balances TO sys_admin;
GRANT SELECT ON TABLE api.account_balances TO tenant_admin;


--
-- Name: TABLE portkey_configs; Type: ACL; Schema: data; Owner: geohuz
--

GRANT ALL ON TABLE data.portkey_configs TO api_views_owner;


--
-- Name: TABLE tenant; Type: ACL; Schema: data; Owner: geohuz
--

GRANT ALL ON TABLE data.tenant TO api_views_owner;


--
-- Name: TABLE user_profile; Type: ACL; Schema: data; Owner: geohuz
--

GRANT SELECT ON TABLE data.user_profile TO api_views_owner;


--
-- Name: TABLE audit_log; Type: ACL; Schema: data; Owner: geohuz
--

GRANT ALL ON TABLE data.audit_log TO api_views_owner;


--
-- Name: TABLE audit_logs; Type: ACL; Schema: api; Owner: api_views_owner
--

GRANT SELECT ON TABLE api.audit_logs TO human_admin;
GRANT SELECT,INSERT ON TABLE api.audit_logs TO sys_admin;


--
-- Name: TABLE virtual_key; Type: ACL; Schema: data; Owner: geohuz
--

GRANT ALL ON TABLE data.virtual_key TO api_views_owner;


--
-- Name: TABLE billing_accounts; Type: ACL; Schema: api; Owner: geohuz
--

GRANT ALL ON TABLE api.billing_accounts TO api_views_owner;
GRANT SELECT ON TABLE api.billing_accounts TO norm_user;
GRANT ALL ON TABLE api.billing_accounts TO sys_admin;
GRANT SELECT ON TABLE api.billing_accounts TO tenant_admin;


--
-- Name: TABLE config_types; Type: ACL; Schema: data; Owner: geohuz
--

GRANT ALL ON TABLE data.config_types TO api_views_owner;


--
-- Name: TABLE config_types; Type: ACL; Schema: api; Owner: api_views_owner
--

GRANT SELECT,DELETE,UPDATE ON TABLE api.config_types TO sys_admin;


--
-- Name: TABLE provider_rate; Type: ACL; Schema: data; Owner: geohuz
--

GRANT SELECT ON TABLE data.provider_rate TO api_views_owner;


--
-- Name: TABLE portkey_config_history; Type: ACL; Schema: data; Owner: geohuz
--

GRANT ALL ON TABLE data.portkey_config_history TO api_views_owner;


--
-- Name: TABLE portkey_config_history_view; Type: ACL; Schema: api; Owner: geohuz
--

GRANT ALL ON TABLE api.portkey_config_history_view TO api_views_owner;
GRANT ALL ON TABLE api.portkey_config_history_view TO sys_admin;


--
-- Name: TABLE portkey_configs_view; Type: ACL; Schema: api; Owner: geohuz
--

GRANT ALL ON TABLE api.portkey_configs_view TO api_views_owner;
GRANT ALL ON TABLE api.portkey_configs_view TO sys_admin;


--
-- Name: TABLE portkey_config_templates; Type: ACL; Schema: data; Owner: geohuz
--

GRANT ALL ON TABLE data.portkey_config_templates TO api_views_owner;


--
-- Name: TABLE portkey_templates_view; Type: ACL; Schema: api; Owner: geohuz
--

GRANT ALL ON TABLE api.portkey_templates_view TO api_views_owner;
GRANT ALL ON TABLE api.portkey_templates_view TO sys_admin;


--
-- Name: TABLE tenants; Type: ACL; Schema: api; Owner: api_views_owner
--

GRANT ALL ON TABLE api.tenants TO sys_admin;
GRANT SELECT ON TABLE api.tenants TO tenant_admin;
GRANT SELECT ON TABLE api.tenants TO norm_user;


--
-- Name: TABLE tier_definitions; Type: ACL; Schema: data; Owner: geohuz
--

GRANT SELECT ON TABLE data.tier_definitions TO api_views_owner;


--
-- Name: TABLE tier_feature_mappings; Type: ACL; Schema: data; Owner: geohuz
--

GRANT ALL ON TABLE data.tier_feature_mappings TO api_views_owner;


--
-- Name: TABLE topup_record; Type: ACL; Schema: data; Owner: geohuz
--

GRANT ALL ON TABLE data.topup_record TO api_views_owner;


--
-- Name: TABLE topup_records; Type: ACL; Schema: api; Owner: api_views_owner
--

GRANT ALL ON TABLE api.topup_records TO sys_admin;
GRANT SELECT ON TABLE api.topup_records TO tenant_admin;
GRANT SELECT ON TABLE api.topup_records TO norm_user;


--
-- Name: TABLE usage_log; Type: ACL; Schema: data; Owner: geohuz
--

GRANT ALL ON TABLE data.usage_log TO api_views_owner;


--
-- Name: TABLE usage_logs; Type: ACL; Schema: api; Owner: api_views_owner
--

GRANT ALL ON TABLE api.usage_logs TO sys_admin;
GRANT SELECT ON TABLE api.usage_logs TO human_admin;
GRANT SELECT ON TABLE api.usage_logs TO norm_user;
GRANT SELECT ON TABLE api.usage_logs TO tenant_admin;


--
-- Name: TABLE api_key; Type: ACL; Schema: data; Owner: geohuz
--

GRANT ALL ON TABLE data.api_key TO api_views_owner;


--
-- Name: TABLE user_api_keys; Type: ACL; Schema: api; Owner: api_views_owner
--

GRANT ALL ON TABLE api.user_api_keys TO sys_admin;
GRANT SELECT ON TABLE api.user_api_keys TO tenant_admin;
GRANT SELECT ON TABLE api.user_api_keys TO norm_user;


--
-- Name: TABLE user_profiles; Type: ACL; Schema: api; Owner: api_views_owner
--

GRANT SELECT ON TABLE api.user_profiles TO norm_user;
GRANT ALL ON TABLE api.user_profiles TO sys_admin;
GRANT SELECT ON TABLE api.user_profiles TO tenant_admin;


--
-- Name: TABLE user_status_log; Type: ACL; Schema: data; Owner: geohuz
--

GRANT ALL ON TABLE data.user_status_log TO api_views_owner;


--
-- Name: TABLE user_status_logs; Type: ACL; Schema: api; Owner: api_views_owner
--

GRANT ALL ON TABLE api.user_status_logs TO sys_admin;
GRANT SELECT ON TABLE api.user_status_logs TO tenant_admin;
GRANT SELECT ON TABLE api.user_status_logs TO norm_user;


--
-- Name: TABLE virtual_keys; Type: ACL; Schema: api; Owner: api_views_owner
--

GRANT SELECT ON TABLE api.virtual_keys TO sys_admin;


--
-- Name: TABLE virtual_keys_by_customer_type; Type: ACL; Schema: api; Owner: api_views_owner
--

GRANT ALL ON TABLE api.virtual_keys_by_customer_type TO sys_admin;


--
-- Name: TABLE billing_event; Type: ACL; Schema: data; Owner: geohuz
--

GRANT SELECT ON TABLE data.billing_event TO api_views_owner;


--
-- Name: TABLE config_levels; Type: ACL; Schema: data; Owner: geohuz
--

GRANT ALL ON TABLE data.config_levels TO api_views_owner;


--
-- Name: TABLE customer_type_rate; Type: ACL; Schema: data; Owner: geohuz
--

GRANT ALL ON TABLE data.customer_type_rate TO api_views_owner;


--
-- Name: TABLE provider_call_log; Type: ACL; Schema: data; Owner: geohuz
--

GRANT SELECT ON TABLE data.provider_call_log TO api_views_owner;


--
-- Name: TABLE rate_limit; Type: ACL; Schema: data; Owner: geohuz
--

GRANT ALL ON TABLE data.rate_limit TO api_views_owner;


--
-- Name: TABLE system_config; Type: ACL; Schema: internal; Owner: geohuz
--

GRANT SELECT ON TABLE internal.system_config TO sys_admin;


--
-- PostgreSQL database dump complete
--

\unrestrict ZBDTiQxQqIZQVrJsvlC0s2uKYDURczCZDwoPjynoFurOsn2l6QiVWrAIDJHgBZc

