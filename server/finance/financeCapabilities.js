const CAPABILITIES = Object.freeze({
  monthly_report_export: Object.freeze({
    availability: 'enabled',
    execution: 'deterministic',
    formats: Object.freeze(['pdf', 'xlsx'])
  }),
  financial_position: Object.freeze({
    availability: 'placeholder',
    execution: 'none',
    message: '当前仅基于收支账本，完整资产负债分析尚未启用。'
  }),
  ai_finance_analysis: Object.freeze({
    availability: 'disabled',
    execution: 'none',
    reasonCode: 'MODEL_ROUTING_REQUIRED'
  })
});

export function getFinanceCapabilities() {
  return {
    monthly_report_export: { ...CAPABILITIES.monthly_report_export, formats: [...CAPABILITIES.monthly_report_export.formats] },
    financial_position: { ...CAPABILITIES.financial_position },
    ai_finance_analysis: { ...CAPABILITIES.ai_finance_analysis }
  };
}

