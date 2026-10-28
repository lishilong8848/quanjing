import { canViewPersonProfileDetails } from '../../shared/person-profile-access';
import { canViewOrganizationPersonProfile } from '../../shared/organization-person-profile';
import type { AccessPrincipal, AccessRole } from '../../shared/access-control.interface';
import { isConfirmedLoginSession } from '../../client/src/access/session-commit-coordinator';

const actor=(nativeRole:AccessRole|null=null):AccessPrincipal=>({role:nativeRole || 'guest',purchaseBuilding:null,effectiveAuthorization:{mode:'independent',baseline:{nativeRole,pages:['/organization','/monthly-schedule'],rules:[]},overrides:{rules:[],allowPages:[],denyPages:[]}}});
describe('private personnel capability boundaries',()=>{
  it('keeps the distinct native role policies for the two kinds of private profile',()=>{
    expect(canViewPersonProfileDetails(actor('duty_editor'))).toBe(true);
    expect(canViewOrganizationPersonProfile(actor('duty_editor'))).toBe(false);
    expect(canViewOrganizationPersonProfile(actor('editor'))).toBe(true);
  });
  it('granting organization page read does not expose either private profile',()=>{
    const value=actor();value.effectiveAuthorization!.overrides.allowPages=['/organization','/monthly-schedule'];
    expect(canViewPersonProfileDetails(value)).toBe(false);
    expect(canViewOrganizationPersonProfile(value)).toBe(false);
  });
  it('a named private grant works for an independent identity, with personal deny taking precedence',()=>{
    const value=actor();value.effectiveAuthorization!.overrides.rules=[{id:'private-read',module:'personnel_profile',effect:'allow',actions:['read'],buildings:null,specialties:null}];
    expect(canViewPersonProfileDetails(value)).toBe(true);
    expect(canViewOrganizationPersonProfile(value)).toBe(false);
    value.effectiveAuthorization!.overrides.rules.push({...value.effectiveAuthorization!.overrides.rules[0],id:'private-deny',effect:'deny'});
    expect(canViewPersonProfileDetails(value)).toBe(false);
  });
  it.each(['local-editor-all',`feishu-${'a'.repeat(64)}`,`local-external-${'b'.repeat(64)}`])('confirms a server-managed independent guest-base identity %s',accountId=>{
    const session={role:'guest',purchaseBuilding:null,accountId,authorizationVersion:2,displayName:'合成账号',principalFingerprint:'synthetic-session'};
    expect(isConfirmedLoginSession(session,session)).toBe(true);
    expect(isConfirmedLoginSession(session,{...session,authorizationVersion:3})).toBe(false);
    expect(isConfirmedLoginSession({...session,authorizationVersion:undefined},{...session,authorizationVersion:undefined})).toBe(false);
  });
});
