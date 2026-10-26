import {
  createContext,
  useContext,
  useState,
  type PropsWithChildren,
} from 'react';
import type { AccessPrincipal } from '../../../shared/access-control.interface';

export const FIXTURE_PRINCIPALS: Record<string, AccessPrincipal> = {
  admin: { role: 'admin', purchaseBuilding: null },
  editor: { role: 'editor', purchaseBuilding: null },
  guest: { role: 'guest', purchaseBuilding: null },
  station: { role: 'building_admin', purchaseBuilding: '110站' },
  ...Object.fromEntries(
    ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'].map((purchaseBuilding) => [
      purchaseBuilding,
      { role: 'building_admin', purchaseBuilding },
    ]),
  ),
};
const Context = createContext('admin');
export function useAccess() {
  const identity = useContext(Context);
  return {
    ...FIXTURE_PRINCIPALS[identity],
    principalFingerprint: `fixture-${identity}`,
    capabilities: { canForceRefresh: identity !== 'guest' },
  };
}
export function FixtureAccessProvider({ children }: PropsWithChildren) {
  const [identity, setIdentity] = useState(
    sessionStorage.getItem('ledger-fixture-principal') || 'admin',
  );
  return (
    <Context.Provider value={identity}>
      <label style={{ display: 'block', padding: '.5rem 1rem' }}>
        权限验收
        <select
          aria-label="验收身份"
          value={identity}
          onChange={(event) => {
            sessionStorage.setItem(
              'ledger-fixture-principal',
              event.target.value,
            );
            setIdentity(event.target.value);
          }}
        >
          {Object.keys(FIXTURE_PRINCIPALS).map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      {children}
    </Context.Provider>
  );
}
