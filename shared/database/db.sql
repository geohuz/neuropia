\restrict Bdxk0OApK1aO18jXKfn7CA3PYOmAloN0Jzt6kXrHGwTi4l0GlcyWNUeDQ0vqKuP

CREATE SCHEMA api;


ALTER SCHEMA api OWNER TO geohuz;


CREATE SCHEMA auth;


ALTER SCHEMA auth OWNER TO geohuz;


CREATE SCHEMA data;


ALTER SCHEMA data OWNER TO geohuz;


CREATE SCHEMA internal;


ALTER SCHEMA internal OWNER TO geohuz;


CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;



CREATE EXTENSION IF NOT EXISTS pgjwt WITH SCHEMA public;



CREATE TYPE auth.jwt_token AS (
	token text
);


ALTER TYPE auth.jwt_token OWNER TO geohuz;


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


CREATE FUNCTION api.cleanup_test_user() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    uid uuid;
BEGIN
TRUNCATE TABLE user_status_log RESTART IDENTITY CASCADE;
TRUNCATE TABLE data.billing_event RESTART IDENTITY CASCADE;
TRUNCATE TABLE data.usage_log RESTART IDENTITY CASCADE;
TRUNCATE TABLE data.topup_record  RESTART IDENTITY CASCADE;
TRUNCATE TABLE data.account_balance RESTART IDENTITY CASCADE;  -- 先清余额表
TRUNCATE TABLE data.user_profile RESTART IDENTITY CASCADE;
TRUNCATE TABLE data.api_key RESTART IDENTITY CASCADE;
DELETE FROM auth.login WHERE id <> (SELECT id FROM auth.login WHERE email = 'api@neuropia');
END;
$$;


ALTER FUNCTION api.cleanup_test_user() OWNER TO geohuz;


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
    PERFORM pg_notify('config_update', new_id::text);

    RETURN new_id;
END;
$$;


ALTER FUNCTION api.create_portkey_config(p_tenant_id uuid, p_user_id uuid, p_config_name text, p_config_json jsonb, p_effective_from timestamp with time zone, p_notes text, p_created_by uuid) OWNER TO geohuz;


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


CREATE FUNCTION api.create_virtual_key(p_user_id uuid, p_name text, p_description text DEFAULT NULL::text, p_rate_limit_rpm integer DEFAULT 1000, p_rate_limit_tpm integer DEFAULT 100000, p_allowed_models text[] DEFAULT '{}'::text[]) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_virtual_key TEXT;
    v_tenant_id UUID;
BEGIN
    -- 生成 virtual key
    v_virtual_key := 'vk_' || encode(gen_random_bytes(16), 'hex');

    -- 获取租户ID
    SELECT tenant_id INTO v_tenant_id
    FROM data.user_profile
    WHERE user_id = p_user_id;

    -- 插入 virtual key 记录
    INSERT INTO data.virtual_key (
        user_id, virtual_key, name, description,
        rate_limit_rpm, rate_limit_tpm, allowed_models
    ) VALUES (
        p_user_id, v_virtual_key, p_name, p_description,
        p_rate_limit_rpm, p_rate_limit_tpm, p_allowed_models
    );

    -- 审计日志
    INSERT INTO data.audit_log (
        actor_id, action, target_type, target_id, detail
    ) VALUES (
        p_user_id, 'CREATE_VIRTUAL_KEY', 'virtual_key', v_virtual_key,
        jsonb_build_object(
            'name', p_name,
            'rate_limits', jsonb_build_object(
                'rpm', p_rate_limit_rpm,
                'tpm', p_rate_limit_tpm
            )
        )
    );

    RETURN v_virtual_key;
END;
$$;


ALTER FUNCTION api.create_virtual_key(p_user_id uuid, p_name text, p_description text, p_rate_limit_rpm integer, p_rate_limit_tpm integer, p_allowed_models text[]) OWNER TO geohuz;


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
    PERFORM pg_notify('config_update', p_id::text);
END;
$$;


ALTER FUNCTION api.deactivate_portkey_config(p_id uuid, p_reason text, p_deactivated_by uuid) OWNER TO geohuz;


CREATE FUNCTION api.generate_virtual_key(p_user_id uuid, p_key_type_id uuid, p_name text, p_description text DEFAULT NULL::text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_tenant_id UUID;
    v_tenant_name TEXT;
    v_type_name TEXT;
    v_key_prefix TEXT;
    v_random_part TEXT;
    v_checksum TEXT;
    v_virtual_key TEXT;
BEGIN
    -- 获取租户和类型信息
    SELECT up.tenant_id, t.name, vkt.type_name
    INTO v_tenant_id, v_tenant_name, v_type_name
    FROM data.user_profile up
    JOIN data.tenant t ON up.tenant_id = t.id
    JOIN data.virtual_key_types vkt ON vkt.id = p_key_type_id
    WHERE up.user_id = p_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'User or key type not found';
    END IF;

    -- 生成前缀 (小写，去除特殊字符)
    v_key_prefix := LOWER(REGEXP_REPLACE(v_tenant_name, '[^a-zA-Z0-9]', ''));

    -- 生成随机部分 (8字符)
    v_random_part := SUBSTRING(ENCODE(GEN_RANDOM_BYTES(6), 'hex') FROM 1 FOR 8);

    -- 生成简单校验和 (4字符)
    v_checksum := SUBSTRING(MD5(v_key_prefix || '_' || v_type_name || '_' || v_random_part) FROM 1 FOR 4);

    -- 组合完整 Virtual Key
    v_virtual_key := 'vk_' || v_key_prefix || '_' || v_type_name || '_' || v_random_part || '_' || v_checksum;

    -- 插入记录
    INSERT INTO data.virtual_key (
        user_id, key_type_id, virtual_key, key_prefix,
        name, description, rate_limit_rpm, rate_limit_tpm, allowed_models
    ) SELECT
        p_user_id, p_key_type_id, v_virtual_key, v_key_prefix,
        p_name, p_description,
        vkt.rate_limit_rpm, vkt.rate_limit_tpm, vkt.allowed_models
    FROM data.virtual_key_types vkt
    WHERE vkt.id = p_key_type_id;

    RETURN v_virtual_key;
END;
$$;


ALTER FUNCTION api.generate_virtual_key(p_user_id uuid, p_key_type_id uuid, p_name text, p_description text) OWNER TO geohuz;


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


CREATE FUNCTION api.get_portkey_template(p_id uuid) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    AS $$
SELECT template_json
FROM data.portkey_config_templates
WHERE id = p_id;
$$;


ALTER FUNCTION api.get_portkey_template(p_id uuid) OWNER TO geohuz;


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


CREATE FUNCTION api.rotate_virtual_key(p_old_virtual_key text, p_reason text DEFAULT 'security_rotation'::text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_key_record data.virtual_key%ROWTYPE;
    v_new_virtual_key TEXT;
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
    v_new_virtual_key := api.generate_virtual_key(
        v_key_record.user_id,
        v_key_record.key_type_id,
        v_key_record.name || ' (rotated)',
        v_key_record.description
    );

    -- 停用旧密钥
    UPDATE data.virtual_key
    SET is_active = false,
        updated_at = NOW(),
        description = COALESCE(description, '') || ' - Rotated: ' || p_reason
    WHERE virtual_key = p_old_virtual_key;

    -- 记录审计日志
    INSERT INTO data.audit_log (
        actor_id, action, target_type, target_id, detail
    ) VALUES (
        v_key_record.user_id, 'ROTATE_VIRTUAL_KEY', 'virtual_key', p_old_virtual_key,
        jsonb_build_object(
            'old_key', p_old_virtual_key,
            'new_key', v_new_virtual_key,
            'reason', p_reason
        )
    );

    RETURN v_new_virtual_key;
END;
$$;


ALTER FUNCTION api.rotate_virtual_key(p_old_virtual_key text, p_reason text) OWNER TO geohuz;


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
    PERFORM pg_notify('config_update', p_id::text);

    RETURN p_id;
END;
$$;


ALTER FUNCTION api.update_portkey_config(p_id uuid, p_config_json jsonb, p_effective_from timestamp with time zone, p_notes text, p_updated_by uuid) OWNER TO geohuz;


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


CREATE FUNCTION data.update_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


ALTER FUNCTION data.update_timestamp() OWNER TO geohuz;


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


CREATE TABLE data.account_balance (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    balance numeric DEFAULT 0,
    overdue_amount numeric DEFAULT 0
);


ALTER TABLE data.account_balance OWNER TO geohuz;


CREATE TABLE data.user_profile (
    user_id uuid NOT NULL,
    username text NOT NULL,
    tenant_id uuid,
    status text DEFAULT 'pending'::text,
    created_at timestamp with time zone DEFAULT now(),
    canceled_at timestamp with time zone,
    default_config_id uuid
);


ALTER TABLE data.user_profile OWNER TO geohuz;


CREATE VIEW api.account_balances AS
 SELECT ab.id,
    ab.user_id,
    up.username,
    up.tenant_id,
    ab.balance,
    ab.overdue_amount
   FROM (data.account_balance ab
     JOIN data.user_profile up ON ((ab.user_id = up.user_id)));


ALTER VIEW api.account_balances OWNER TO api_views_owner;


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


CREATE TABLE data.tenant (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    contact text,
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    default_template_id uuid
);


ALTER TABLE data.tenant OWNER TO geohuz;


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


ALTER VIEW api.audit_logs OWNER TO api_owner;


CREATE TABLE data.provider_rate (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT provider_rates_id_not_null NOT NULL,
    provider text CONSTRAINT provider_rates_provider_not_null NOT NULL,
    model text CONSTRAINT provider_rates_model_not_null NOT NULL,
    price_per_token numeric CONSTRAINT provider_rates_price_per_token_not_null NOT NULL,
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
    notes text,
    portkey_target_name text
);


ALTER TABLE data.provider_rate OWNER TO geohuz;


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


CREATE TABLE data.customer_rate (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT customer_rates_id_not_null NOT NULL,
    customer_type text CONSTRAINT customer_rates_customer_type_not_null NOT NULL,
    price_per_token numeric CONSTRAINT customer_rates_price_per_token_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE data.customer_rate OWNER TO geohuz;


CREATE VIEW api.customer_rates AS
 SELECT id,
    customer_type,
    price_per_token,
    created_at
   FROM data.customer_rate;


ALTER VIEW api.customer_rates OWNER TO api_views_owner;


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


CREATE VIEW api.portkey_templates_view AS
 SELECT id,
    tenant_id,
    template_name,
    template_json,
    is_global,
    created_at
   FROM data.portkey_config_templates;


ALTER VIEW api.portkey_templates_view OWNER TO geohuz;


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


CREATE VIEW api.tenants AS
 SELECT id,
    name,
    contact,
    notes,
    created_at
   FROM data.tenant;


ALTER VIEW api.tenants OWNER TO api_views_owner;


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


CREATE TABLE data.api_key (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT api_keys_id_not_null NOT NULL,
    login_id uuid,
    api_key text CONSTRAINT api_keys_api_key_not_null NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


ALTER TABLE data.api_key OWNER TO geohuz;


CREATE VIEW api.user_api_keys AS
 SELECT id,
    login_id AS user_id,
    api_key,
    created_at
   FROM data.api_key;


ALTER VIEW api.user_api_keys OWNER TO api_views_owner;


CREATE VIEW api.user_profiles AS
 SELECT user_id,
    username,
    tenant_id,
    status,
    created_at,
    canceled_at
   FROM data.user_profile;


ALTER VIEW api.user_profiles OWNER TO api_views_owner;


CREATE TABLE data.user_status_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    old_status text,
    new_status text,
    changed_at timestamp without time zone DEFAULT now()
);


ALTER TABLE data.user_status_log OWNER TO geohuz;


CREATE VIEW api.user_status_logs AS
 SELECT id,
    user_id,
    old_status,
    new_status,
    changed_at
   FROM data.user_status_log;


ALTER VIEW api.user_status_logs OWNER TO api_views_owner;


CREATE TABLE data.virtual_key (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    virtual_key text NOT NULL,
    name text NOT NULL,
    description text,
    rate_limit_rpm integer DEFAULT 1000,
    rate_limit_tpm integer DEFAULT 100000,
    allowed_models text[] DEFAULT '{}'::text[],
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    key_type_id uuid,
    key_prefix text
);


ALTER TABLE data.virtual_key OWNER TO geohuz;


CREATE VIEW api.virtual_key_details AS
 SELECT vk.id,
    vk.user_id,
    vk.virtual_key,
    vk.name,
    vk.description,
    vk.rate_limit_rpm,
    vk.rate_limit_tpm,
    vk.allowed_models,
    vk.is_active,
    vk.created_at,
    vk.updated_at,
    up.username,
    up.status AS user_status,
    ab.balance,
    t.name AS tenant_name
   FROM (((data.virtual_key vk
     JOIN data.user_profile up ON ((vk.user_id = up.user_id)))
     LEFT JOIN data.account_balance ab ON ((vk.user_id = ab.user_id)))
     LEFT JOIN data.tenant t ON ((up.tenant_id = t.id)))
  WHERE (vk.is_active = true);


ALTER VIEW api.virtual_key_details OWNER TO geohuz;


CREATE VIEW api.virtual_keys AS
 SELECT vk.id,
    vk.user_id,
    vk.virtual_key,
    vk.name,
    vk.description,
    vk.rate_limit_rpm,
    vk.rate_limit_tpm,
    vk.allowed_models,
    vk.is_active,
    vk.created_at,
    vk.updated_at,
    up.username,
    up.tenant_id
   FROM (data.virtual_key vk
     JOIN data.user_profile up ON ((vk.user_id = up.user_id)));


ALTER VIEW api.virtual_keys OWNER TO geohuz;


CREATE TABLE auth.login (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    hashed_password text NOT NULL,
    role text NOT NULL
);


ALTER TABLE auth.login OWNER TO geohuz;


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


CREATE TABLE data.config_cache_status (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    config_type text NOT NULL,
    config_id uuid NOT NULL,
    cache_key text NOT NULL,
    last_updated timestamp with time zone DEFAULT now(),
    cache_version integer DEFAULT 1
);


ALTER TABLE data.config_cache_status OWNER TO geohuz;


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


CREATE TABLE data.virtual_key_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    type_name text NOT NULL,
    description text,
    rate_limit_rpm integer DEFAULT 1000,
    rate_limit_tpm integer DEFAULT 100000,
    allowed_models text[] DEFAULT '{}'::text[],
    max_requests_per_month integer,
    cost_center text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE data.virtual_key_types OWNER TO geohuz;


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


ALTER TABLE ONLY auth.login
    ADD CONSTRAINT login_email_key UNIQUE (email);



ALTER TABLE ONLY auth.login
    ADD CONSTRAINT login_pkey PRIMARY KEY (id);



ALTER TABLE ONLY data.account_balance
    ADD CONSTRAINT account_balance_pkey PRIMARY KEY (id);



ALTER TABLE ONLY data.account_balance
    ADD CONSTRAINT account_balance_user_id_unique UNIQUE (user_id);



ALTER TABLE ONLY data.api_key
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);



ALTER TABLE ONLY data.audit_log
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);



ALTER TABLE ONLY data.billing_event
    ADD CONSTRAINT billing_events_pkey PRIMARY KEY (id);



ALTER TABLE ONLY data.config_cache_status
    ADD CONSTRAINT config_cache_status_pkey PRIMARY KEY (id);



ALTER TABLE ONLY data.customer_rate
    ADD CONSTRAINT customer_rates_pkey PRIMARY KEY (id);



ALTER TABLE ONLY data.gateway_routes
    ADD CONSTRAINT gateway_routes_pkey PRIMARY KEY (id);



ALTER TABLE ONLY data.model_configs
    ADD CONSTRAINT model_configs_model_name_key UNIQUE (model_name);



ALTER TABLE ONLY data.model_configs
    ADD CONSTRAINT model_configs_pkey PRIMARY KEY (id);



ALTER TABLE ONLY data.portkey_config_history
    ADD CONSTRAINT portkey_config_history_pkey PRIMARY KEY (id);



ALTER TABLE ONLY data.portkey_config_templates
    ADD CONSTRAINT portkey_config_templates_pkey PRIMARY KEY (id);



ALTER TABLE ONLY data.portkey_configs
    ADD CONSTRAINT portkey_configs_pkey PRIMARY KEY (id);



ALTER TABLE ONLY data.provider_call_log
    ADD CONSTRAINT provider_call_logs_pkey PRIMARY KEY (id);



ALTER TABLE ONLY data.provider_rate
    ADD CONSTRAINT provider_rates_pkey PRIMARY KEY (id);



ALTER TABLE ONLY data.rate_limit
    ADD CONSTRAINT rate_limits_pkey PRIMARY KEY (id);



ALTER TABLE ONLY data.tenant
    ADD CONSTRAINT tenant_pkey PRIMARY KEY (id);



ALTER TABLE ONLY data.topup_record
    ADD CONSTRAINT topup_records_pkey PRIMARY KEY (id);



ALTER TABLE ONLY data.api_key
    ADD CONSTRAINT uniq_login_id UNIQUE (login_id);



ALTER TABLE ONLY data.usage_log
    ADD CONSTRAINT usage_logs_pkey PRIMARY KEY (id);



ALTER TABLE ONLY data.user_profile
    ADD CONSTRAINT user_profile_pkey PRIMARY KEY (user_id);



ALTER TABLE ONLY data.user_profile
    ADD CONSTRAINT user_profile_username_key UNIQUE (username);



ALTER TABLE ONLY data.user_status_log
    ADD CONSTRAINT user_status_log_pkey PRIMARY KEY (id);



ALTER TABLE ONLY data.virtual_key
    ADD CONSTRAINT virtual_key_pkey PRIMARY KEY (id);



ALTER TABLE ONLY data.virtual_key_types
    ADD CONSTRAINT virtual_key_types_pkey PRIMARY KEY (id);



ALTER TABLE ONLY data.virtual_key_usage
    ADD CONSTRAINT virtual_key_usage_pkey PRIMARY KEY (id);



ALTER TABLE ONLY data.virtual_key
    ADD CONSTRAINT virtual_key_virtual_key_key UNIQUE (virtual_key);



ALTER TABLE ONLY internal.system_config
    ADD CONSTRAINT system_config_config_key_key UNIQUE (config_key);



ALTER TABLE ONLY internal.system_config
    ADD CONSTRAINT system_config_pkey PRIMARY KEY (id);



CREATE INDEX gin_portkey_configs_json ON data.portkey_configs USING gin (config_json);



CREATE INDEX gin_portkey_templates_json ON data.portkey_config_templates USING gin (template_json);



CREATE INDEX idx_model_configs_active ON data.model_configs USING btree (is_active) WHERE (is_active = true);



CREATE INDEX idx_model_configs_family ON data.model_configs USING btree (family);



CREATE INDEX idx_model_configs_provider ON data.model_configs USING btree (provider);



CREATE INDEX idx_portkey_config_history_config_id ON data.portkey_config_history USING btree (config_id);



CREATE INDEX idx_portkey_configs_tenant_user ON data.portkey_configs USING btree (tenant_id, user_id);



CREATE INDEX idx_portkey_templates_tenant ON data.portkey_config_templates USING btree (tenant_id);



CREATE UNIQUE INDEX uniq_portkey_configs_name_version ON data.portkey_configs USING btree (tenant_id, user_id, config_name, version);



CREATE UNIQUE INDEX uniq_portkey_templates_name_version ON data.portkey_config_templates USING btree (tenant_id, template_name, version);



CREATE TRIGGER encrypt_pass BEFORE INSERT OR UPDATE ON auth.login FOR EACH ROW EXECUTE FUNCTION auth.encrypt_pass();



CREATE CONSTRAINT TRIGGER ensure_user_role_exists AFTER INSERT OR UPDATE ON auth.login NOT DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION auth.check_role_exists();



CREATE TRIGGER update_portkey_configs_timestamp BEFORE UPDATE ON data.portkey_configs FOR EACH ROW EXECUTE FUNCTION data.update_timestamp();



CREATE TRIGGER update_portkey_templates_timestamp BEFORE UPDATE ON data.portkey_config_templates FOR EACH ROW EXECUTE FUNCTION data.update_timestamp();



ALTER TABLE ONLY data.account_balance
    ADD CONSTRAINT account_balance_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.login(id);



ALTER TABLE ONLY data.billing_event
    ADD CONSTRAINT fk_billing_user FOREIGN KEY (user_id) REFERENCES auth.login(id);



ALTER TABLE ONLY data.topup_record
    ADD CONSTRAINT fk_topup_user FOREIGN KEY (user_id) REFERENCES auth.login(id);



ALTER TABLE ONLY data.gateway_routes
    ADD CONSTRAINT gateway_routes_config_template_id_fkey FOREIGN KEY (config_template_id) REFERENCES data.portkey_config_templates(id);



ALTER TABLE ONLY data.portkey_config_history
    ADD CONSTRAINT portkey_config_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES auth.login(id);



ALTER TABLE ONLY data.portkey_config_history
    ADD CONSTRAINT portkey_config_history_config_id_fkey FOREIGN KEY (config_id) REFERENCES data.portkey_configs(id) ON DELETE CASCADE;



ALTER TABLE ONLY data.portkey_config_templates
    ADD CONSTRAINT portkey_config_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.login(id);



ALTER TABLE ONLY data.portkey_config_templates
    ADD CONSTRAINT portkey_config_templates_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES data.tenant(id) ON DELETE CASCADE;



ALTER TABLE ONLY data.portkey_configs
    ADD CONSTRAINT portkey_configs_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.login(id);



ALTER TABLE ONLY data.portkey_configs
    ADD CONSTRAINT portkey_configs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES data.tenant(id) ON DELETE CASCADE;



ALTER TABLE ONLY data.portkey_configs
    ADD CONSTRAINT portkey_configs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.login(id) ON DELETE CASCADE;



ALTER TABLE ONLY data.provider_rate
    ADD CONSTRAINT provider_rate_previous_version_id_fkey FOREIGN KEY (previous_version_id) REFERENCES data.provider_rate(id);



ALTER TABLE ONLY data.user_profile
    ADD CONSTRAINT user_profile_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES data.tenant(id);



ALTER TABLE ONLY data.user_profile
    ADD CONSTRAINT user_profile_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.login(id);



ALTER TABLE ONLY data.virtual_key
    ADD CONSTRAINT virtual_key_key_type_id_fkey FOREIGN KEY (key_type_id) REFERENCES data.virtual_key_types(id);



ALTER TABLE ONLY data.virtual_key_types
    ADD CONSTRAINT virtual_key_types_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES data.tenant(id);



ALTER TABLE ONLY data.virtual_key_usage
    ADD CONSTRAINT virtual_key_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.login(id);



ALTER TABLE ONLY data.virtual_key
    ADD CONSTRAINT virtual_key_user_id_fkey FOREIGN KEY (user_id) REFERENCES data.user_profile(user_id);



ALTER TABLE data.account_balance ENABLE ROW LEVEL SECURITY;


CREATE POLICY account_balance_access_for_user ON data.account_balance USING ((data.userid() = user_id));



CREATE POLICY account_balance_sys_admin ON data.account_balance USING ((((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'sys_admin'::text));



CREATE POLICY account_balance_tenant ON data.account_balance FOR SELECT USING (((((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'tenant_admin'::text) AND (user_id IN ( SELECT up.user_id
   FROM data.user_profile up
  WHERE (up.tenant_id = ( SELECT user_profile.tenant_id
           FROM data.user_profile
          WHERE (user_profile.user_id = (((current_setting('request.jwt.claims'::text, true))::json ->> 'userid'::text))::uuid)))))));



CREATE POLICY admin_access ON data.usage_log USING ((((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'sys_admin'::text));



ALTER TABLE data.usage_log ENABLE ROW LEVEL SECURITY;


CREATE POLICY user_access ON data.usage_log FOR SELECT USING ((user_id = (((current_setting('request.jwt.claims'::text, true))::json ->> 'userid'::text))::uuid));
