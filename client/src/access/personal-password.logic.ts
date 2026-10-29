export function validateNewPersonalPassword(password: string, confirmation: string): string | null {
  // Validate length without changing the password sent to the server.
  if (Array.from(password.trim()).length < 8 || Array.from(password).length > 128) return '新密码需为 8 至 128 个字符';
  if (password !== confirmation) return '两次输入的新密码不一致';
  return null;
}

export function validatePasswordResetIdentity(name: string, identity: string): string | null {
  if (!name.trim()) return '请输入本人姓名';
  if (!/^\d{17}[\dXx]$/.test(identity.trim())) return '请输入本人完整的 18 位身份证号';
  return null;
}

/** One in-memory mutation id per unchanged payload, including uncertain retries. Never persists secrets. */
export function createPersonalMutationIdentity(idFactory: () => string = () => crypto.randomUUID()) {
  let previous = '', id = '';
  return {
    forPayload(payload: unknown) {
      const next = JSON.stringify(payload);
      if (next !== previous || !id) { previous = next; id = idFactory(); }
      return id;
    },
    clear() { previous = ''; id = ''; },
  };
}
