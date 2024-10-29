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

class Mod implements IPreSptLoadMod {
    preSptLoad(container: DependencyContainer): void {
        const logger = container.resolve<ILogger>("WinstonLogger");
        // container.register<LocationLifecycleServiceExtension>("LocationLifecycleServiceExtension", LocationLifecycleServiceExtension);
        // container.register("LocationLifecycleService", { useToken: "LocationLifecycleServiceExtension" });

        container.register<InRaidHelperExtension>("InRaidHelperExtension", InRaidHelperExtension);
        container.register("InRaidHelper", { useToken: "InRaidHelperExtension" });

        logger.success("[InsurancePlus] Loaded successfully.");
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
    protected isItemKeptAfterDeath(pmcData: IPmcData, itemToCheck: IItem): boolean {
        const original = super.isItemKeptAfterDeath(pmcData, itemToCheck);
        if (original) return true;

        // If it's not been marked to keep then we need to check if it's insured and handle it accordingly.
        const insuredIndex = pmcData.InsuredItems.findIndex((item) => item.itemId === itemToCheck._id);

        // if it's insured
        if (insuredIndex !== -1) {
            if (this.config.LoseInsuranceOnItemAfterDeath) {
                // Remove insured status
                pmcData.InsuredItems.splice(insuredIndex, 1);
            }
            // Keep the item
            return true;
        }

        // If it's a required item.
        


        return false;
    }
}