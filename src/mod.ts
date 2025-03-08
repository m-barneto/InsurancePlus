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
import { LocationLifecycleService } from "@spt/services/LocationLifecycleService";
import { ApplicationContext } from "@spt/context/ApplicationContext";
import { LocationLootGenerator } from "@spt/generators/LocationLootGenerator";
import { LootGenerator } from "@spt/generators/LootGenerator";
import { PlayerScavGenerator } from "@spt/generators/PlayerScavGenerator";
import { HealthHelper } from "@spt/helpers/HealthHelper";
import { TraderHelper } from "@spt/helpers/TraderHelper";
import { SaveServer } from "@spt/servers/SaveServer";
import { BotGenerationCacheService } from "@spt/services/BotGenerationCacheService";
import { BotLootCacheService } from "@spt/services/BotLootCacheService";
import { BotNameService } from "@spt/services/BotNameService";
import { InsuranceService } from "@spt/services/InsuranceService";
import { LocalisationService } from "@spt/services/LocalisationService";
import { MailSendService } from "@spt/services/MailSendService";
import { MatchBotDetailsCacheService } from "@spt/services/MatchBotDetailsCacheService";
import { PmcChatResponseService } from "@spt/services/PmcChatResponseService";
import { RaidTimeAdjustmentService } from "@spt/services/RaidTimeAdjustmentService";
import { HashUtil } from "@spt/utils/HashUtil";
import { RandomUtil } from "@spt/utils/RandomUtil";
import { TimeUtil } from "@spt/utils/TimeUtil";
import { IEndLocalRaidRequestData } from "@spt/models/eft/match/IEndLocalRaidRequestData";
import { BaseClasses } from "@spt/models/enums/BaseClasses";

class Mod implements IPreSptLoadMod {
    static logger: ILogger;

    preSptLoad(container: DependencyContainer): void {
        Mod.logger = container.resolve<ILogger>("WinstonLogger");
        
        container.register<InRaidHelperExtension>("InRaidHelperExtension", InRaidHelperExtension);
        container.register("InRaidHelper", { useToken: "InRaidHelperExtension" });

        container.register<LocationLifecycleServiceExtension>("LocationLifecycleServiceExtension", LocationLifecycleServiceExtension);
        container.register("LocationLifecycleService", { useToken: "LocationLifecycleServiceExtension" });
                                    
        Mod.logger.success("[InsurancePlus] Loaded successfully.");
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

        const itemsToUninsure: string[] = [];

        for (const child of itemsLostOnDeath) {
            // If it's not been marked to keep then we need to check if it's insured and handle it accordingly.
            const insuredIndex = this.findInsuranceIndex(pmcData, child._id);

            // if it's insured
            if (insuredIndex !== -1) {
                if (this.config.LoseInsuranceOnItemAfterDeath) {
                    // Remove insured status
                    itemsToUninsure.push(child._id);
                    //pmcData.InsuredItems.splice(insuredIndex, 1);
                }
                // Keep the item but now let's do the same check for the children
                const addToUninsured: string[] = this.recursiveRemoveUninsured(pmcData, sessionId, child, pmcData.Inventory.items);
                itemsToUninsure.push(...addToUninsured);
            } else {
                // Not insured
                // If item is ammo, inside mag or gun (slotid check), and we want to keep it, dont remove
                // ^ opposite of this to make it easier to read
                if (!(this.itemHelper.isOfBaseclass(child._tpl, BaseClasses.AMMO) && ["cartridges", "patron_in_weapon", "patron_in_weapon_000", "patron_in_weapon_001"].includes(child.slotId) && !this.config.LoseAmmoInMagazines)) {
                    this.inventoryHelper.removeItem(pmcData, child._id, sessionId);
                }
            }
        }

        // Remove insurance from items
        pmcData.InsuredItems = pmcData.InsuredItems.filter(insuredItem => {
            return !itemsToUninsure.includes(insuredItem.itemId);
        });
        
        // Remove contents of fast panel
        pmcData.Inventory.fastPanel = {};
    }

    private recursiveRemoveUninsured(pmcData: IPmcData, sessionId: string, parentItem: IItem, items: IItem[]): string[] {
        const itemsToUninsure: string[] = [];

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
                    itemsToUninsure.push(child._id);
                }
                // It's insured, remove children if theyre uninsured
                const addToUninsured: string[] = this.recursiveRemoveUninsured(pmcData, sessionId, child, items);
                itemsToUninsure.push(...addToUninsured);
            } else {
                // If item is ammo, inside mag or gun (slotid check), and we want to keep it, dont remove
                // ^ opposite of this to make it easier to read
                if (!(this.itemHelper.isOfBaseclass(child._tpl, BaseClasses.AMMO) && ["cartridges", "patron_in_weapon", "patron_in_weapon_000", "patron_in_weapon_001"].includes(child.slotId) && !this.config.LoseAmmoInMagazines)) {
                    this.inventoryHelper.removeItem(pmcData, child._id, sessionId);
                }
            }
        }

        return itemsToUninsure;
    }

    private findInsuranceIndex(pmcData: IPmcData, itemId: string): number {
        return pmcData.InsuredItems.findIndex((x) => x.itemId === itemId);
    }
}

@injectable()
class LocationLifecycleServiceExtension extends LocationLifecycleService {
    private config: ModConfig = require("../config/config.json");
    constructor(
        @inject("PrimaryLogger") protected logger: ILogger,
        @inject("HashUtil") protected hashUtil: HashUtil,
        @inject("SaveServer") protected saveServer: SaveServer,
        @inject("TimeUtil") protected timeUtil: TimeUtil,
        @inject("RandomUtil") protected randomUtil: RandomUtil,
        @inject("ProfileHelper") protected profileHelper: ProfileHelper,
        @inject("DatabaseService") protected databaseService: DatabaseService,
        @inject("InRaidHelper") protected inRaidHelper: InRaidHelper,
        @inject("HealthHelper") protected healthHelper: HealthHelper,
        @inject("QuestHelper") protected questHelper: QuestHelper,
        @inject("MatchBotDetailsCacheService") protected matchBotDetailsCacheService: MatchBotDetailsCacheService,
        @inject("PmcChatResponseService") protected pmcChatResponseService: PmcChatResponseService,
        @inject("PlayerScavGenerator") protected playerScavGenerator: PlayerScavGenerator,
        @inject("TraderHelper") protected traderHelper: TraderHelper,
        @inject("LocalisationService") protected localisationService: LocalisationService,
        @inject("InsuranceService") protected insuranceService: InsuranceService,
        @inject("BotLootCacheService") protected botLootCacheService: BotLootCacheService,
        @inject("ConfigServer") protected configServer: ConfigServer,
        @inject("BotGenerationCacheService") protected botGenerationCacheService: BotGenerationCacheService,
        @inject("MailSendService") protected mailSendService: MailSendService,
        @inject("RaidTimeAdjustmentService") protected raidTimeAdjustmentService: RaidTimeAdjustmentService,
        @inject("BotNameService") protected botNameService: BotNameService,
        @inject("LootGenerator") protected lootGenerator: LootGenerator,
        @inject("ApplicationContext") protected applicationContext: ApplicationContext,
        @inject("LocationLootGenerator") protected locationLootGenerator: LocationLootGenerator,
        @inject("PrimaryCloner") protected cloner: ICloner
    ) {
        Mod.logger.info("GUH LocationLifecycleService");
        super(logger,
            hashUtil,
            saveServer,
            timeUtil,
            randomUtil,
            profileHelper,
            databaseService,
            inRaidHelper,
            healthHelper,
            questHelper,
            matchBotDetailsCacheService,
            pmcChatResponseService,
            playerScavGenerator,
            traderHelper,
            localisationService,
            insuranceService,
            botLootCacheService,
            configServer,
            botGenerationCacheService,
            mailSendService,
            raidTimeAdjustmentService,
            botNameService,
            lootGenerator,
            applicationContext,
            locationLootGenerator,
            cloner);
    }

    public handleInsuredItemLostEvent(
        sessionId: string,
        preRaidPmcProfile: IPmcData,
        request: IEndLocalRaidRequestData,
        locationName: string
    ): void {
        if (request.lostInsuredItems?.length > 0) {
            const pmcData: IPmcData = this.profileHelper.getPmcProfile(sessionId);

            // Remove items that are found in the players inventory (they werent lost)
            request.lostInsuredItems = request.lostInsuredItems.filter(x => {
                return pmcData.Inventory.items.filter(y => y._id === x._id).length == 0;
            });


            const mappedItems = this.insuranceService.mapInsuredItemsToTrader(
                sessionId,
                request.lostInsuredItems,
                request.results.profile
            );

            // Is possible to have items in lostInsuredItems but removed before reaching mappedItems
            if (mappedItems.length === 0) {
                return;
            }

            this.insuranceService.storeGearLostInRaidToSendLater(sessionId, mappedItems);

            this.insuranceService.startPostRaidInsuranceLostProcess(preRaidPmcProfile, sessionId, locationName);
        }
    }
}