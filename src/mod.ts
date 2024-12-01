import { DependencyContainer, inject, injectable } from "tsyringe";
import { IPreSptLoadMod } from "@spt/models/external/IPreSptLoadMod";
import { ILogger } from "@spt/models/spt/utils/ILogger";
import { InRaidHelper } from "@spt/helpers/InRaidHelper";
import { ProfileHelper } from "@spt/helpers/ProfileHelper";
import { QuestHelper } from "@spt/helpers/QuestHelper";
import { ConfigServer } from "@spt/servers/ConfigServer";
import { DatabaseService } from "@spt/services/DatabaseService";
import { ICloner } from "@spt/utils/cloners/ICloner";
import { IPmcData } from "@spt/models/eft/common/IPmcData";
import { QuestController } from "@spt/controllers/QuestController";
import { InventoryHelper } from "@spt/helpers/InventoryHelper";
import { ItemHelper } from "@spt/helpers/ItemHelper";
import { IItem } from "@spt/models/eft/common/tables/IItem";
import { LocaleService } from "@spt/services/LocaleService";
import { ITemplateItem } from "@spt/models/eft/common/tables/ITemplateItem";
import { ISeasonalEventConfig } from "@spt/models/spt/config/ISeasonalEventConfig";
import { ConfigTypes } from "@spt/models/enums/ConfigTypes";

class Mod implements IPreSptLoadMod {
    public static locales: Record<string, string>;
    public static itemTemplates: Record<string, ITemplateItem>;
    preSptLoad(container: DependencyContainer): void {
        const logger = container.resolve<ILogger>("WinstonLogger");

        container.register<InRaidHelperExtension>("InRaidHelperExtension", InRaidHelperExtension);
        container.register("InRaidHelper", { useToken: "InRaidHelperExtension" });

        logger.success("[InsurancePlus] Loaded successfully.");
    }

    postSptLoad(container: DependencyContainer): void {
        Mod.locales = container.resolve<LocaleService>("LocaleService").getLocaleDb();
        Mod.itemTemplates = container.resolve<DatabaseService>("DatabaseService").getTables().templates.items;

        // get the config server so we can get a config with it
        const configServer = container.resolve<ConfigServer>("ConfigServer");

        // Request seasonal event config
        const seasonConfig: ISeasonalEventConfig = configServer.getConfig<ISeasonalEventConfig>(ConfigTypes.SEASONAL_EVENT);

        for (const seasonEvent of seasonConfig.events) {
            // changes here
            seasonEvent.enabled = true;
            
        }
    }
}

export const mod = new Mod();

interface ModConfig {
    LoseInsuranceOnItemAfterDeath: boolean;
    LoseAmmoInMagazines: boolean;
}

@injectable()
class InRaidHelperExtension extends InRaidHelper {
    private config: ModConfig = require("../config/config.json");

    constructor(
        @inject("PrimaryLogger") protected logger: ILogger,
        @inject("InventoryHelper") protected inventoryHelper: InventoryHelper,
        @inject("ItemHelper") protected itemHelper: ItemHelper,
        @inject("ConfigServer") protected configServer: ConfigServer,
        @inject("PrimaryCloner") protected cloner: ICloner,
        @inject("DatabaseService") protected databaseService: DatabaseService,
        @inject("QuestController") protected questController: QuestController,
        @inject("ProfileHelper") protected profileHelper: ProfileHelper,
        @inject("QuestHelper") protected questHelper: QuestHelper
    ) {
        super(
            logger,
            inventoryHelper,
            itemHelper,
            configServer,
            cloner,
            databaseService,
            questController,
            profileHelper,
            questHelper
        )
    }

    /**
     * Clear PMC inventory of all items except those that are exempt
     * Used post-raid to remove items after death
     * @param pmcData Player profile
     * @param sessionId Session id
     */
    public deleteInventory(pmcData: IPmcData, sessionId: string): void {
        // Get inventory item ids to remove from players profile
        const itemsLostOnDeath = this.getInventoryItemsLostOnDeath(pmcData);

        for (const item of itemsLostOnDeath) {
            // If it's not been marked to keep then we need to check if it's insured and handle it accordingly.
            const insuredIndex = this.findInsuranceIndex(pmcData, item._id);

            // if it's insured
            if (insuredIndex !== -1) {
                if (this.config.LoseInsuranceOnItemAfterDeath) {
                    // Remove insured status
                    pmcData.InsuredItems.splice(insuredIndex, 1);
                }
                // Keep the item but now let's do the same check for the children
                this.recursiveRemoveUninsured(pmcData, sessionId, item, pmcData.Inventory.items);
            } else {
                // Not insured
                // If it's a required item then we're not gonna remove it
                // if(!this.isRequiredItem(item,))

                // Items inside containers are handled as part of function
                this.inventoryHelper.removeItem(pmcData, item._id, sessionId);
            }
        }

        // Remove contents of fast panel
        pmcData.Inventory.fastPanel = {};
    }

    private recursiveRemoveUninsured(pmcData: IPmcData, sessionId: string, parentItem: IItem, items: IItem[]) {
        // Get the childen of the parent we're looking for (remove the parent from the list)
        const children = this.itemHelper.findAndReturnChildrenAsItems(items, parentItem._id);
        // Remove parent item
        children.splice(0, 1);

        // parent is not going to be removed, so check children and make sure theyre insured, otherwise remove them
        for (const child of children) {
            const insuredIndex = this.findInsuranceIndex(pmcData, child._id);
            if (insuredIndex !== -1) {
                // Insured, maybe remove insurance status and check the children of the item
                if (this.config.LoseInsuranceOnItemAfterDeath) {
                    // Remove insured status
                    pmcData.InsuredItems.splice(insuredIndex, 1);
                }
                this.recursiveRemoveUninsured(pmcData, sessionId, child, items);
            } else {
                // Remove item as it's not insured
                this.inventoryHelper.removeItem(pmcData, child._id, sessionId);
            }
        }
    }

    private findInsuranceIndex(pmcData: IPmcData, itemId: string): number {
        return pmcData.InsuredItems.findIndex((x) => x.itemId === itemId);
    }
}