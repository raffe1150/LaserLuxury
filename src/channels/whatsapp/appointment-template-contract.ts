export type AppointmentTemplateFact = 'customer_name' | 'service' | 'date' | 'time' | 'business_name';
export const APPOINTMENT_TEMPLATE_FACTS: readonly AppointmentTemplateFact[] =
  ['customer_name', 'service', 'date', 'time', 'business_name'];

// Existing send-time configuration rules, shared by the stricter canonical
// publisher. Keep legacy compatible mappings supported when automation is off.
export function isRuntimeReminderMapping(mapping: any, identity: { businessId: string; wabaId: string; phoneNumberId: string }, language: string): boolean {
  return mapping?.business_id === identity.businessId && Boolean(identity.wabaId) && mapping.waba_id === identity.wabaId &&
    Boolean(identity.phoneNumberId) && mapping.phone_number_id === identity.phoneNumberId &&
    typeof mapping.template_id === 'string' && Boolean(mapping.template_id.trim()) &&
    typeof mapping.name === 'string' && /^[a-z0-9_]+$/u.test(mapping.name) &&
    typeof mapping.language_code === 'string' && /^[a-z]{2,3}(?:_[A-Z]{2})?$/u.test(mapping.language_code) &&
    mapping.language_code.split('_')[0] === language && Array.isArray(mapping.body_parameters) &&
    mapping.body_parameters.length > 0 && mapping.body_parameters.length <= 20 &&
    mapping.body_parameters.every((key: any) => APPOINTMENT_TEMPLATE_FACTS.includes(key)) &&
    ['service', 'date', 'time'].every(key => mapping.body_parameters.includes(key));
}

// Shared by read-only provisioning inspection and send-time verification.
// Default-field Meta responses can omit parameter_format; keep the existing
// sender's compatibility, while explicit-field preflight requires POSITIONAL.
export function hasCompatibleAppointmentTemplateBody(
  template: any,
  parameterCount: number,
  requireExplicitPositionalFormat = false,
): boolean {
  const components = template?.components;
  if (!Array.isArray(components) ||
      (requireExplicitPositionalFormat ? template.parameter_format !== 'POSITIONAL' :
        template.parameter_format != null && template.parameter_format !== 'POSITIONAL')) return false;
  const bodies = components.filter(part => part?.type === 'BODY');
  if (bodies.length !== 1 || typeof bodies[0].text !== 'string' ||
      components.some(part => !part || part.type !== 'BODY' && !(
        ['HEADER', 'FOOTER'].includes(part.type) && typeof part.text === 'string' &&
        !part.text.includes('{{') && (part.type !== 'HEADER' || part.format === 'TEXT')
      ))) return false;
  const placeholders = [...bodies[0].text.matchAll(/\{\{(.*?)\}\}/gu)].map(match => match[1]);
  const keys = [...new Set<string>(placeholders)].sort((a, b) => Number(a) - Number(b));
  return keys.length === parameterCount && keys.every((key, index) => key === String(index + 1));
}
