import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable } from '@nestjs/common';
import type { CardRoleCode, ConfigurationPerson } from '../../../shared/access-configuration.interface';
import { PurchaseWorkflowGateway } from '../../modules/purchase-inventory/purchase-workflow.gateway';
import { InventoryWarehouseRoleDirectory } from '../../modules/inventory-outbound-approval/inventory-warehouse-role-directory';
import { readPurchaseManagerApprovers } from '../../modules/purchase-inventory/purchase-manager-approval.config';
import { readConfiguredCardMembers } from './access-configuration.service';
import { validCardRule } from './access-configuration.validation';
import { readEnv } from '../config/external-services.config';

@Injectable()
export class AccessConfigurationCardDirectory {
  private readonly purchase: PurchaseWorkflowGateway;
  private readonly warehouse: InventoryWarehouseRoleDirectory;
  constructor(http: HttpService) { this.purchase = new PurchaseWorkflowGateway(http); this.warehouse = new InventoryWarehouseRoleDirectory(http); }
  async read(code: CardRoleCode, building: string | null): Promise<{ members: ConfigurationPerson[] | null; description?: string }> {
    if (!validCardRule({ appId: process.env.FEISHU_APP_ID || '', code, building: building as never, version: 1, members: [{ openId: 'ou_validation', name: 'validation' }] })) throw new BadRequestException('卡片角色或楼栋无效');
    const configured = readConfiguredCardMembers(code, building);
    if (configured !== null) return { members: configured };
    let members: ConfigurationPerson[];
    switch (code) {
      case 'purchase_manager': members = readPurchaseManagerApprovers(); break;
      case 'purchase_approvers': members = await this.purchase.resolveConfiguredApproversAsApp(); break;
      case 'purchase_executor': members = [await this.purchase.resolvePurchaseAdminAsApp()]; break;
      case 'building_executor': members = [await this.purchase.resolveBuildingSupervisorAsApp(building!)]; break;
      case 'warehouse_responsible': members = await this.warehouse.resolveApprovers(building!); break;
      case 'warehouse_notify': members = await this.warehouse.resolveNotificationRecipients(building!); break;
      case 'contract_notify': {
        const ids = readEnv('FEISHU_CONTRACT_NOTIFICATION_RECEIVER_OPEN_IDS').split(/[，,;；\s]+/).map(id => id.trim()).filter(id => /^ou_[A-Za-z0-9]+$/.test(id));
        return ids.length ? { members: ids.map(openId => ({ openId, name: openId })) } : { members: null, description: '按合同负责人和现有合同通知规则确定' };
      }
    }
    return { members: members.map(person => ({ openId: person.openId, name: person.name || person.openId })) };
  }
}
