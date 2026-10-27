/* eslint-disable */
/** auto generated, do not edit */
import { pgTable, pgPolicy, varchar, text, date, bigint, uuid, uniqueIndex, index, boolean, jsonb, integer, pgEnum, customType } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const userProfile = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return 'user_profile';
  },
  toDriver(value: string) {
    return sql`ROW(${value})::user_profile`;
  },
  fromDriver(value: string) {
    const [userId] = value.slice(1, -1).split(',');
    return userId.trim();
  },
});

export type FileAttachment = {
  bucket_id: string;
  file_path: string;
};

export const fileAttachment = customType<{
  data: FileAttachment;
  driverData: string;
}>({
  dataType() {
    return 'file_attachment';
  },
  toDriver(value: FileAttachment) {
    return sql`ROW(${value.bucket_id},${value.file_path})::file_attachment`;
  },
  fromDriver(value: string): FileAttachment {
    const [bucketId, filePath] = value.slice(1, -1).split(',');
    return { bucket_id: bucketId.trim(), file_path: filePath.trim() };
  },
});

/** Escape single quotes in SQL string literals */
function escapeLiteral(str: string): string {
  return `'${str.replace(/'/g, "''")}'`;
}

export const userProfileArray = customType<{
  data: string[];
  driverData: string;
}>({
  dataType() {
    return 'user_profile[]';
  },
  toDriver(value: string[]) {
    if (!value || value.length === 0) {
      return sql`'{}'::user_profile[]`;
    }
    const elements = value.map(id => `ROW(${escapeLiteral(id)})::user_profile`).join(',');
    return sql.raw(`ARRAY[${elements}]::user_profile[]`);
  },
  fromDriver(value: string): string[] {
    if (!value || value === '{}') return [];
    const inner = value.slice(1, -1);
    const matches = inner.match(/\([^)]*\)/g) || [];
    return matches.map(m => m.slice(1, -1).split(',')[0].trim());
  },
});

export const fileAttachmentArray = customType<{
  data: FileAttachment[];
  driverData: string;
}>({
  dataType() {
    return 'file_attachment[]';
  },
  toDriver(value: FileAttachment[]) {
    if (!value || value.length === 0) {
      return sql`'{}'::file_attachment[]`;
    }
    const elements = value.map(f =>
      `ROW(${escapeLiteral(f.bucket_id)},${escapeLiteral(f.file_path)})::file_attachment`
    ).join(',');
    return sql.raw(`ARRAY[${elements}]::file_attachment[]`);
  },
  fromDriver(value: string): FileAttachment[] {
    if (!value || value === '{}') return [];
    const inner = value.slice(1, -1);
    const matches = inner.match(/\([^)]*\)/g) || [];
    return matches.map(m => {
      const [bucketId, filePath] = m.slice(1, -1).split(',');
      return { bucket_id: bucketId.trim(), file_path: filePath.trim() };
    });
  },
});

export const customTimestamptz = customType<{
  data: Date;
  driverData: string;
  config: { precision?: number};
}>({
  dataType(config) {
    const precision = typeof config?.precision !== 'undefined'
      ? ` (${config.precision})`
      : '';
    return `timestamptz${precision}`;
  },
  toDriver(value: Date | string | number){
    if(value == null) return value as any;
    if (typeof value === 'number') {
      return new Date(value).toISOString();
    }
    if(typeof value === 'string') {
      return value;
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    throw new Error('Invalid timestamp value');
  },
  fromDriver(value: string | Date): Date {
    if(value instanceof Date) return value;
    return new Date(value);
  },
});

export const appBuilding = pgEnum("app_building", ['app_building_a', 'app_building_b', 'app_building_c', 'app_building_d', 'app_building_e', 'app_building_h', 'station_110'])
export const appShift = pgEnum("app_shift", ['shift_white', 'shift_night', 'changbai'])
export const appTeam = pgEnum("app_team", ['shift_a', 'shift_b', 'shift_c', 'shift_d', 'changbai'])
export const building = pgEnum("building", ['building_a', 'building_b', 'building_c', 'building_d', 'building_e', 'building_h', 'station_110'])
export const building9eym = pgEnum("building_9EYm", ['app_a_building', 'app_b_building', 'app_c_building', 'app_d_building', 'app_e_building', 'app_h_building', 'station_110'])
export const buildingCepy = pgEnum("building_CEPY", ['a_building', 'b_building', 'c_building', 'd_building', 'e_building', 'h_building', 'station_110'])
export const buildingCdeb = pgEnum("building_CdEB", ['building_a', 'building_b', 'building_c', 'building_d', 'building_e', 'building_h', 'station_110'])
export const buildingS8ny = pgEnum("building_S8NY", ['a_building', 'b_building', 'c_building', 'd_building', 'e_building', 'h_building', 'station_110'])
export const buildingWymk = pgEnum("building_WyMK", ['a_building', 'b_building', 'c_building', 'd_building', 'e_building', 'h_building', 'station_110'])
export const buildingXdme = pgEnum("building_XDME", ['a_building', 'b_building', 'c_building', 'd_building', 'e_building', 'h_building', 'station_110'])
export const buildingEnum = pgEnum("building_enum", ['A楼', 'B楼', 'C楼', 'D楼', 'E楼', 'H楼', '110站'])
export const buildingLii8 = pgEnum("building_liI8", ['a_building', 'b_building', 'c_building', 'd_building', 'e_building', 'h_building', 'station_110'])
export const buildingSpecialtyEnum = pgEnum("building_specialty_enum", ['H楼', 'A楼', 'B楼', 'C楼', 'D楼', 'E楼', '110站', '弱电', '电气', '暖通', '消防', '安全', '综合'])
export const buildingXjvx = pgEnum("building_xJvx", ['a_building', 'b_building', 'c_building', 'd_building', 'e_building', 'h_building', 'station_110'])
export const positionEnum = pgEnum("position_enum", ['设施运维经理', '设施运维主管', '弱电主管', '电气主管', '暖通主管', '设施运维副经理', '综合管理', '电气工程师', '暖通工程师', '弱电工程师', '安全&消防工程师', '消防工程师', '消防主管', '值班账号', 'FOC'])
export const shift = pgEnum("shift", ['white', 'night', 'long_white'])
export const shiftCjkv = pgEnum("shift_Cjkv", ['white', 'night', 'changbai'])
export const shiftI0zv = pgEnum("shift_I0ZV", ['white_shift', 'night_shift', 'changbai'])
export const shiftSyk5 = pgEnum("shift_Syk5", ['white_shift', 'night_shift', 'long_white_shift'])
export const shiftVaza = pgEnum("shift_VaZA", ['white', 'night', 'changbai'])
export const shiftWlzk = pgEnum("shift_Wlzk", ['white', 'night', 'changbai'])
export const shiftXafj = pgEnum("shift_XAfJ", ['white', 'night', 'changbai'])
export const shiftEnum = pgEnum("shift_enum", ['白', '夜', '长白'])
export const shiftType = pgEnum("shift_type", ['shift_white', 'shift_night', 'changbai'])
export const shiftWs76 = pgEnum("shift_ws76", ['white', 'night', 'changbai'])
export const team = pgEnum("team", ['shift_a', 'shift_b', 'shift_c', 'shift_d', 'long_white'])
export const teamJ3ff = pgEnum("team_J3FF", ['a_shift', 'b_shift', 'c_shift', 'd_shift', 'changbai'])
export const teamNfxf = pgEnum("team_NfXf", ['shift_a', 'shift_b', 'shift_c', 'shift_d', 'changbai'])
export const teamUhho = pgEnum("team_Uhho", ['shift_a', 'shift_b', 'shift_c', 'shift_d', 'changbai'])
export const teamEnum = pgEnum("team_enum", ['A班', 'B班', 'C班', 'D班', '长白'])
export const workGroup = pgEnum("work_group", ['shift_a', 'shift_b', 'shift_c', 'shift_d', 'changbai'])
export const workGroupMcxe = pgEnum("work_group_McXe", ['shift_a', 'shift_b', 'shift_c', 'shift_d', 'changbai'])
export const workTeam = pgEnum("work_team", ['shift_a', 'shift_b', 'shift_c', 'shift_d', 'changbai'])
export const workTeam31cc = pgEnum("work_team_31CC", ['shift_a', 'shift_b', 'shift_c', 'shift_d', 'changbai'])
export const workTeamL7xo = pgEnum("work_team_L7Xo", ['shift_a', 'shift_b', 'shift_c', 'shift_d', 'long_white_shift'])

export const appRoomScheduleEnhanced = pgTable("app_room_schedule_enhanced", {
  recordId: varchar("record_id", { length: 255 }).notNull(),
  dutyCode: text("duty_code"),
  scheduleDate: date("schedule_date"),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  code: bigint({ mode: "number" }),
  building: varchar({ length: 255 }),
  team: varchar({ length: 255 }),
  shift: varchar({ length: 255 }),
  dutyStaffReference: text("duty_staff_reference").array(),
  dutyStaffActual: text("duty_staff_actual").array(),
  remark: text(),
  emergencyDuty: text("emergency_duty"),
  emergencyDutySchedule: text("emergency_duty_schedule"),
  leaveStaff: text("leave_staff").array(),
  substituteStaff: text("substitute_staff").array(),
  actualDutyStaff: text("actual_duty_staff"),
  buildingText: text("building_text"),
  teamText: text("team_text"),
  shiftText: text("shift_text"),
  personText: text("person_text"),
  id: uuid("_id").defaultRandom().notNull(),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz('_created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by"),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz('_updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by"),
}, (table) => [
  pgPolicy("service_role_bypass_policy", { as: "permissive", for: "all", to: ["service_role_workspace_aadjo3mumt6ns"], using: sql`true` }),
  pgPolicy("修改全部数据", { as: "permissive", for: "all", to: ["authenticated_workspace_aadjo3mumt6ns"] }),
  pgPolicy("查看全部数据", { as: "permissive", for: "select", to: ["anon_workspace_aadjo3mumt6ns", "authenticated_workspace_aadjo3mumt6ns"] }),
  pgPolicy("修改本人数据", { as: "permissive", for: "all", to: ["authenticated_workspace_aadjo3mumt6ns"] }),
]);

export const appSyncConfig = pgTable("app_sync_config", {
  id: uuid().defaultRandom().notNull(),
  configKey: varchar("config_key", { length: 255 }).notNull(),
  configValue: text("config_value"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz('_created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by"),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz('_updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by"),
}, (table) => [
  uniqueIndex("idx_app_sync_config_key").using("btree", table.configKey.asc().nullsLast().op("text_ops")),
  pgPolicy("service_role_bypass_policy", { as: "permissive", for: "all", to: ["service_role_workspace_aadjo3mumt6ns"], using: sql`true` }),
  pgPolicy("修改全部数据", { as: "permissive", for: "all", to: ["authenticated_workspace_aadjo3mumt6ns"] }),
  pgPolicy("查看全部数据", { as: "permissive", for: "select", to: ["anon_workspace_aadjo3mumt6ns", "authenticated_workspace_aadjo3mumt6ns"] }),
  pgPolicy("修改本人数据", { as: "permissive", for: "all", to: ["authenticated_workspace_aadjo3mumt6ns"] }),
]);

export const appSealingInfo = pgTable("app_sealing_info", {
  id: uuid().defaultRandom().notNull(),
  bitableRecordId: varchar("bitable_record_id", { length: 255 }).notNull(),
  sealingCode: varchar("sealing_code", { length: 255 }).notNull(),
  sealingName: text("sealing_name").notNull(),
  startDate: customTimestamptz('start_date').notNull(),
  endDate: customTimestamptz('end_date').notNull(),
  sealingType: varchar("sealing_type", { length: 255 }),
  autoNumber: varchar("auto_number", { length: 255 }),
  isToday: boolean("is_today").default(false),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz('_created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by"),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz('_updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by"),
}, (table) => [
  uniqueIndex("idx_app_sealing_info_bitable_id").using("btree", table.bitableRecordId.asc().nullsLast().op("text_ops")),
  index("idx_app_sealing_info_date_range").using("btree", table.startDate.asc().nullsLast().op("timestamptz_ops"), table.endDate.asc().nullsLast().op("timestamptz_ops")),
  pgPolicy("service_role_bypass_policy", { as: "permissive", for: "all", to: ["service_role_workspace_aadjo3mumt6ns"], using: sql`true` }),
  pgPolicy("修改全部数据", { as: "permissive", for: "all", to: ["authenticated_workspace_aadjo3mumt6ns"] }),
  pgPolicy("查看全部数据", { as: "permissive", for: "select", to: ["anon_workspace_aadjo3mumt6ns", "authenticated_workspace_aadjo3mumt6ns"] }),
  pgPolicy("修改本人数据", { as: "permissive", for: "all", to: ["authenticated_workspace_aadjo3mumt6ns"] }),
]);

export const dutyScheduleBase = pgTable("duty_schedule_base", {
  id: uuid().defaultRandom().notNull(),
  building: buildingEnum().notNull(),
  team: teamEnum().notNull(),
  shift: shiftEnum().notNull(),
  dutyPersonActual: text("duty_person_actual").notNull(),
  scheduleDate: date("schedule_date").notNull(),
  leavePerson: text("leave_person"),
  substitutePerson: text("substitute_person"),
  transferPerson: text("transfer_person"),
  coverPerson: text("cover_person"),
  emergencyDuty: text("emergency_duty"),
  code: text(),
  recordId: varchar("record_id", { length: 255 }).notNull(),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz('_created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by"),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz('_updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by"),
}, (table) => [
  uniqueIndex("idx_duty_schedule_base_record_id").using("btree", table.recordId.asc().nullsLast().op("text_ops")),
  index("idx_duty_schedule_base_schedule_date").using("btree", table.scheduleDate.asc().nullsLast().op("date_ops")),
  pgPolicy("service_role_bypass_policy", { as: "permissive", for: "all", to: ["service_role_workspace_aadjo3mumt6ns"], using: sql`true` }),
  pgPolicy("修改全部数据", { as: "permissive", for: "all", to: ["authenticated_workspace_aadjo3mumt6ns"] }),
  pgPolicy("查看全部数据", { as: "permissive", for: "select", to: ["anon_workspace_aadjo3mumt6ns", "authenticated_workspace_aadjo3mumt6ns"] }),
  pgPolicy("修改本人数据", { as: "permissive", for: "all", to: ["authenticated_workspace_aadjo3mumt6ns"] }),
]);

export const appBitableSyncRecords = pgTable("app_bitable_sync_records", {
  id: uuid().defaultRandom().notNull(),
  bitableRecordId: varchar("bitable_record_id", { length: 255 }).notNull(),
  /**
   * 记录内容（JSON格式）
   */
  recordContent: jsonb("record_content").notNull(),
  syncTime: customTimestamptz('sync_time').default(sql`CURRENT_TIMESTAMP`),
  status: varchar({ length: 255 }).default('active'),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz('_created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by"),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz('_updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by"),
}, (table) => [
  uniqueIndex("idx_app_bitable_sync_records_bitable_id").using("btree", table.bitableRecordId.asc().nullsLast().op("text_ops")),
  pgPolicy("service_role_bypass_policy", { as: "permissive", for: "all", to: ["service_role_workspace_aadjo3mumt6ns"], using: sql`true` }),
  pgPolicy("修改全部数据", { as: "permissive", for: "all", to: ["authenticated_workspace_aadjo3mumt6ns"] }),
  pgPolicy("查看全部数据", { as: "permissive", for: "select", to: ["anon_workspace_aadjo3mumt6ns", "authenticated_workspace_aadjo3mumt6ns"] }),
  pgPolicy("修改本人数据", { as: "permissive", for: "all", to: ["authenticated_workspace_aadjo3mumt6ns"] }),
  pgPolicy("允许认证用户查看数据", { as: "permissive", for: "select", to: ["authenticated_workspace_aadjo3mumt6ns"] }),
  pgPolicy("允许认证用户修改数据", { as: "permissive", for: "update", to: ["authenticated_workspace_aadjo3mumt6ns"] }),
  pgPolicy("允许认证用户插入数据", { as: "permissive", for: "insert", to: ["authenticated_workspace_aadjo3mumt6ns"] }),
  pgPolicy("允许认证用户删除数据", { as: "permissive", for: "delete", to: ["authenticated_workspace_aadjo3mumt6ns"] }),
]);

export const appEmployeeCertInfoFormal = pgTable("app_employee_cert_info_formal", {
  id: uuid().defaultRandom().notNull(),
  recordId: varchar("record_id"),
  appName: text("app_name"),
  appEmployeeName: userProfile("app_employee_name"),
  buildingProfessional: text("building_professional").array(),
  shift: text(),
  appEmployeeId: text("app_employee_id"),
  employmentType: text("employment_type"),
  position: text(),
  companyName: text("company_name"),
  appIdCard: text("app_id_card"),
  reviewedCertified: boolean("reviewed_certified"),
  appSourceId: text("app_source_id"),
  appHighPressureCertificate: text("app_high_pressure_certificate").array(),
  appHighPressureCertificateExpiryDate: date("app_high_pressure_certificate_expiry_date"),
  appHighPressureCertificateReviewDate: date("app_high_pressure_certificate_review_date"),
  appHighPressureCertificateActualReviewDate: date("app_high_pressure_certificate_actual_review_date"),
  appHighPressureCertificateValidity: text("app_high_pressure_certificate_validity"),
  appHighPressureCertificateNewValidity: text("app_high_pressure_certificate_new_validity"),
  appLowPressureCertificate: text("app_low_pressure_certificate").array(),
  appLowPressureCertificateExpiryDate: date("app_low_pressure_certificate_expiry_date"),
  appLowPressureCertificateReviewDate: date("app_low_pressure_certificate_review_date"),
  appLowVoltageCertificateReviewDate: date("app_low_voltage_certificate_review_date"),
  appLowVoltageCertificateValidity: text("app_low_voltage_certificate_validity"),
  appLowVoltageCertificateValidityNew: text("app_low_voltage_certificate_validity_new"),
  appCoolingCertificate: text("app_cooling_certificate").array(),
  appCoolingCertificateExpiryDate: date("app_cooling_certificate_expiry_date"),
  appCoolingCertificateReviewDate: date("app_cooling_certificate_review_date"),
  appCoolingCertificateReviewDate1: date("app_cooling_certificate_review_date_1"),
  appCoolingCertificateValidity: text("app_cooling_certificate_validity"),
  appCoolingCertificateValidityNew: text("app_cooling_certificate_validity_new"),
  appHighRiseCertificate: text("app_high_rise_certificate").array(),
  appCertExpiryDate: date("app_cert_expiry_date"),
  appCertReviewDate: date("app_cert_review_date"),
  appCertReviewActualDate: date("app_cert_review_actual_date"),
  appCertValidity: text("app_cert_validity"),
  appCertValidityNew: text("app_cert_validity_new"),
  specialDeviceCert: text("special_device_cert").array(),
  safetyManagerCert: text("safety_manager_cert").array(),
  fireOperatorCert: text("fire_operator_cert").array(),
  otherCert: text("other_cert").array(),
  certStatistics: text("cert_statistics"),
  certificateLabeling: text("certificate_labeling").array(),
  certificateCompliance: text("certificate_compliance"),
  missingCertificate: text("missing_certificate"),
  nonCompliantCertificateCount: text("non_compliant_certificate_count"),
  monthlyExpiryReminder: text("monthly_expiry_reminder"),
  certificateName90DaysBeforeReview: text("certificate_name_90days_before_review"),
  highVoltageDaysBeforeReview: text("high_voltage_days_before_review"),
  lowVoltageDaysBeforeReview: text("low_voltage_days_before_review"),
  refrigerationCertificateDaysBeforeReview: text("refrigeration_certificate_days_before_review"),
  certificateRequirementForEmployment: text("certificate_requirement_for_employment"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz('_created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by"),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz('_updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by"),
}, (table) => [
  pgPolicy("service_role_bypass_policy", { as: "permissive", for: "all", to: ["service_role_workspace_aadjo3mumt6ns"], using: sql`true` }),
  pgPolicy("修改全部数据", { as: "permissive", for: "all", to: ["authenticated_workspace_aadjo3mumt6ns"] }),
  pgPolicy("查看全部数据", { as: "permissive", for: "select", to: ["anon_workspace_aadjo3mumt6ns", "authenticated_workspace_aadjo3mumt6ns"] }),
  pgPolicy("修改本人数据", { as: "permissive", for: "all", to: ["authenticated_workspace_aadjo3mumt6ns"] }),
]);

export const nantongOrganization = pgTable("nantong_organization", {
  id: uuid().defaultRandom().notNull(),
  recordId: varchar("record_id", { length: 255 }).notNull(),
  code: text(),
  position: positionEnum().notNull(),
  buildingsSpecialties: text("buildings_specialties").array().notNull(),
  supervisor: text(),
  dutyAccount: varchar("duty_account", { length: 255 }).array().notNull(),
  supervisorText: text("supervisor_text"),
  parentRecord: varchar("parent_record", { length: 255 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz('_created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by"),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz('_updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by"),
}, (table) => [
  index("idx_nantong_organization_position").using("btree", table.position.asc().nullsLast().op("enum_ops")),
  uniqueIndex("idx_nantong_organization_record_id").using("btree", table.recordId.asc().nullsLast().op("text_ops")),
  pgPolicy("service_role_bypass_policy", { as: "permissive", for: "all", to: ["service_role_workspace_aadjo3mumt6ns"], using: sql`true` }),
  pgPolicy("修改全部数据", { as: "permissive", for: "all", to: ["authenticated_workspace_aadjo3mumt6ns"] }),
  pgPolicy("查看全部数据", { as: "permissive", for: "select", to: ["anon_workspace_aadjo3mumt6ns", "authenticated_workspace_aadjo3mumt6ns"] }),
  pgPolicy("修改本人数据", { as: "permissive", for: "all", to: ["authenticated_workspace_aadjo3mumt6ns"] }),
]);

export const appFestivalImportantSchedule = pgTable("app_festival_important_schedule", {
  id: uuid().defaultRandom().notNull(),
  recordId: varchar("record_id"),
  appShiftId: text("app_shift_id"),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  appCode: bigint("app_code", { mode: "number" }),
  appScheduleDate: date("app_schedule_date"),
  appHeavyType: text("app_heavy_type"),
  appScheduleDateWeek: text("app_schedule_date_week"),
  appYearWeek: text("app_year_week"),
  appDutyBuilding: text("app_duty_building"),
  appDutyStaff: userProfileArray("app_duty_staff"),
  appStaffText: text("app_staff_text"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz('_created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by"),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz('_updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by"),
}, (table) => [
  pgPolicy("service_role_bypass_policy", { as: "permissive", for: "all", to: ["service_role_workspace_aadjo3mumt6ns"], using: sql`true` }),
  pgPolicy("修改全部数据", { as: "permissive", for: "all", to: ["authenticated_workspace_aadjo3mumt6ns"] }),
  pgPolicy("查看全部数据", { as: "permissive", for: "select", to: ["anon_workspace_aadjo3mumt6ns", "authenticated_workspace_aadjo3mumt6ns"] }),
  pgPolicy("修改本人数据", { as: "permissive", for: "all", to: ["authenticated_workspace_aadjo3mumt6ns"] }),
]);

export const holidayDutySchedule = pgTable("holiday_duty_schedule", {
  id: uuid().defaultRandom().notNull(),
  recordId: varchar("record_id", { length: 255 }).notNull(),
  dutyCode: text("duty_code"),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  code: bigint({ mode: "number" }),
  scheduleDate: date("schedule_date").notNull(),
  dutyType: varchar("duty_type", { length: 255 }).notNull(),
  scheduleWeekday: text("schedule_weekday"),
  weekNumber: integer("week_number"),
  building: varchar({ length: 255 }).notNull(),
  dutyStaff: userProfile("duty_staff").notNull(),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz('_created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by"),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz('_updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by"),
  dutyStaffText: text("duty_staff_text"),
}, (table) => [
  index("idx_holiday_duty_schedule_building").using("btree", table.building.asc().nullsLast().op("text_ops")),
  index("idx_holiday_duty_schedule_date").using("btree", table.scheduleDate.asc().nullsLast().op("date_ops")),
  uniqueIndex("idx_holiday_duty_schedule_record_id").using("btree", table.recordId.asc().nullsLast().op("text_ops")),
  index("idx_holiday_duty_schedule_type").using("btree", table.dutyType.asc().nullsLast().op("text_ops")),
  pgPolicy("service_role_bypass_policy", { as: "permissive", for: "all", to: ["service_role_workspace_aadjo3mumt6ns"], using: sql`true` }),
  pgPolicy("修改全部数据", { as: "permissive", for: "all", to: ["authenticated_workspace_aadjo3mumt6ns"] }),
  pgPolicy("查看全部数据", { as: "permissive", for: "select", to: ["anon_workspace_aadjo3mumt6ns", "authenticated_workspace_aadjo3mumt6ns"] }),
  pgPolicy("修改本人数据", { as: "permissive", for: "all", to: ["authenticated_workspace_aadjo3mumt6ns"] }),
]);

export const nonDutySchedule = pgTable("non_duty_schedule", {
  id: uuid().defaultRandom().notNull(),
  recordId: varchar("record_id", { length: 255 }).notNull(),
  dutyCode: text("duty_code"),
  code: integer(),
  scheduleDate: date("schedule_date").notNull(),
  building: varchar({ length: 255 }).notNull(),
  team: varchar({ length: 255 }).notNull(),
  personText: text("person_text"),
  dutyStaffActual: text("duty_staff_actual"),
  leaveStaff: text("leave_staff"),
  lastModifiedTime: customTimestamptz('last_modified_time'),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz('_created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by"),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz('_updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by"),
  leaveStaffBitable: text("leave_staff_bitable").array(),
  substituteStaffBitable: text("substitute_staff_bitable").array(),
}, (table) => [
  index("idx_non_duty_schedule_building").using("btree", table.building.asc().nullsLast().op("text_ops")),
  index("idx_non_duty_schedule_date").using("btree", table.scheduleDate.asc().nullsLast().op("date_ops")),
  uniqueIndex("idx_non_duty_schedule_record_id").using("btree", table.recordId.asc().nullsLast().op("text_ops")),
  index("idx_non_duty_schedule_team").using("btree", table.team.asc().nullsLast().op("text_ops")),
  pgPolicy("service_role_bypass_policy", { as: "permissive", for: "all", to: ["service_role_workspace_aadjo3mumt6ns"], using: sql`true` }),
  pgPolicy("修改全部数据", { as: "permissive", for: "all", to: ["authenticated_workspace_aadjo3mumt6ns"] }),
  pgPolicy("查看全部数据", { as: "permissive", for: "select", to: ["anon_workspace_aadjo3mumt6ns", "authenticated_workspace_aadjo3mumt6ns"] }),
  pgPolicy("修改本人数据", { as: "permissive", for: "all", to: ["authenticated_workspace_aadjo3mumt6ns"] }),
]);

// table aliases
export const appBitableSyncRecordsTable = appBitableSyncRecords;
export const appEmployeeCertInfoFormalTable = appEmployeeCertInfoFormal;
export const appFestivalImportantScheduleTable = appFestivalImportantSchedule;
export const appRoomScheduleEnhancedTable = appRoomScheduleEnhanced;
export const appSealingInfoTable = appSealingInfo;
export const appSyncConfigTable = appSyncConfig;
export const dutyScheduleBaseTable = dutyScheduleBase;
export const holidayDutyScheduleTable = holidayDutySchedule;
export const nantongOrganizationTable = nantongOrganization;
export const nonDutyScheduleTable = nonDutySchedule;
