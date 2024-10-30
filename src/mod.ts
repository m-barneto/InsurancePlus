import { DependencyContainer, inject, injectable } from "tsyringe";
import { IPreSptLoadMod } from "@spt/models/external/IPreSptLoadMod";
import { ILogger } from "@spt/models/spt/utils/ILogger";
import { LocationLifecycleService } from "@spt/services/LocationLifecycleService";
import { ApplicationContext } from "@spt/context/ApplicationContext";
import { LocationLootGenerator } from "@spt/generators/LocationLootGenerator";
import { LootGenerator } from "@spt/generators/LootGenerator";
import { PlayerScavGenerator } from "@spt/generators/PlayerScavGenerator";
import { HealthHelper } from "@spt/helpers/HealthHelper";
import { InRaidHelper } from "@spt/helpers/InRaidHelper";
import { ProfileHelper } from "@spt/helpers/ProfileHelper";
import { QuestHelper } from "@spt/helpers/QuestHelper";
import { TraderHelper } from "@spt/helpers/TraderHelper";
import { ConfigServer } from "@spt/servers/ConfigServer";
import { SaveServer } from "@spt/servers/SaveServer";
import { BotGenerationCacheService } from "@spt/services/BotGenerationCacheService";
import { BotLootCacheService } from "@spt/services/BotLootCacheService";
import { BotNameService } from "@spt/services/BotNameService";
import { DatabaseService } from "@spt/services/DatabaseService";
import { InsuranceService } from "@spt/services/InsuranceService";
import { LocalisationService } from "@spt/services/LocalisationService";
import { MailSendService } from "@spt/services/MailSendService";
import { MatchBotDetailsCacheService } from "@spt/services/MatchBotDetailsCacheService";
import { PmcChatResponseService } from "@spt/services/PmcChatResponseService";
import { RaidTimeAdjustmentService } from "@spt/services/RaidTimeAdjustmentService";
import { ICloner } from "@spt/utils/cloners/ICloner";
import { HashUtil } from "@spt/utils/HashUtil";
import { RandomUtil } from "@spt/utils/RandomUtil";
import { TimeUtil } from "@spt/utils/TimeUtil";
import { IPmcData } from "@spt/models/eft/common/IPmcData";
import { Traders } from "@spt/models/enums/Traders";
import { IEndLocalRaidRequestData } from "@spt/models/eft/match/IEndLocalRaidRequestData";
import { QuestController } from "@spt/controllers/QuestController";
import { InventoryHelper } from "@spt/helpers/InventoryHelper";
import { ItemHelper } from "@spt/helpers/ItemHelper";
import { IItem } from "@spt/models/eft/common/tables/IItem";
import { LocaleService } from "@spt/services/LocaleService";

class Mod implements IPreSptLoadMod {
    public static locales: Record<string, string>;
    preSptLoad(container: DependencyContainer): void {
        const logger = container.resolve<ILogger>("WinstonLogger");
        // container.register<LocationLifecycleServiceExtension>("LocationLifecycleServiceExtension", LocationLifecycleServiceExtension);
        // container.register("LocationLifecycleService", { useToken: "LocationLifecycleServiceExtension" });

        container.register<InRaidHelperExtension>("InRaidHelperExtension", InRaidHelperExtension);
        container.register("InRaidHelper", { useToken: "InRaidHelperExtension" });

        logger.success("[InsurancePlus] Loaded successfully.");
    }

    postSptLoad(container: DependencyContainer): void {
        Mod.locales = container.resolve<LocaleService>("LocaleService").getLocaleDb();
    }
}

export const mod = new Mod();

interface ModConfig {
    EnableDefaultInsurance: boolean;
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
        @inject("QuestHelper") protected questHelper: QuestHelper,
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
        const itemIdsToDeleteFromProfile = this.getInventoryItemsLostOnDeath(pmcData).map((item) => item._id);
        for (const itemIdToDelete of itemIdsToDeleteFromProfile) {
            // If it's not been marked to keep then we need to check if it's insured and handle it accordingly.
            const insuredIndex = pmcData.InsuredItems.findIndex((x) => x.itemId === itemIdToDelete);

            // if it's insured
            if (insuredIndex !== -1) {
                if (this.config.LoseInsuranceOnItemAfterDeath) {
                    // Remove insured status
                    pmcData.InsuredItems.splice(insuredIndex, 1);
                }
                // Keep the item but now let's do the same check for the children
                this.recursiveRemoveUninsured(pmcData, sessionId, itemIdToDelete, itemIdsToDeleteFromProfile);
            } else {
                const item = pmcData.Inventory.items.filter((x) => x._id == itemIdToDelete)[0];
                this.logger.info(`Removing: ${Mod.locales[item._tpl + " Name"]}`);
                // Items inside containers are handled as part of function
                this.inventoryHelper.removeItem(pmcData, itemIdToDelete, sessionId);
            }
        }

        // Remove contents of fast panel
        pmcData.Inventory.fastPanel = {};
    }

    private recursiveRemoveUninsured(pmcData: IPmcData, sessionId: string, parentItemId: string, itemIds: string[]) {
        // Get the childen of the parent we're looking for (remove the parent from the list)
        const children = this.itemHelper.findAndReturnChildrenAsItems(pmcData.Inventory.items, parentItemId).splice(0, 1);

        // parent is not going to be removed, so check children and make sure theyre insured, otherwise remove them
        for (const i in children) {
            const child = children[i];
            const insuredIndex = pmcData.InsuredItems.findIndex((x) => x.itemId === child._id);
            if (insuredIndex !== -1) {
                // Insured, maybe remove insurance status and check the children of the item
                if (this.config.LoseInsuranceOnItemAfterDeath) {
                    // Remove insured status
                    pmcData.InsuredItems.splice(insuredIndex, 1);
                }
                this.recursiveRemoveUninsured(pmcData, sessionId, child._id, itemIds);
            } else {
                // Remove item as it's not insured
                // Items inside containers are handled as part of function
                this.logger.info(`Removing: ${Mod.locales[child._tpl + " Name"]}`);
                this.inventoryHelper.removeItem(pmcData, child._id, sessionId);
            }
        }
    }
}