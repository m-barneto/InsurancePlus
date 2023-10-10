"use strict";

class Mod {
	// container to use outside pre-, post- loads
	static container;
	
	preAkiLoad(container) {
		// safe this reference to use instead of normal container
		Mod.container = container;
		
		// do the good old swaperoo
		container.afterResolution("InraidController", (_t, result) => {
			result.savePmcProgress = (sessionID, offraidData) => {
				return Mod.customSavePmc(sessionID, offraidData)
			}
		}, {frequency: "Always"});
	}
	
	postDBLoad(container) {
		// constants
		const logger = container.resolve("WinstonLogger");
		const database = container.resolve("DatabaseServer").getTables();
		const config = require("../config/config.json");
		const viableMaps = ["bigmap", "factory4_day", "factory4_night", "interchange", "lighthouse", "rezervbase", "shoreline", "woods"];
		
		// if default insurance is turned off, make it false in map files
		// dont handle labs, base game already has it at false
		if (!config.EnableDefaultInsurance) {
			for (const map in database.locations) {
				if (viableMaps.includes(map)) {
					database.locations[map].base.Insurance = false;
				}
			}
		}
	}
	
	static customSavePmc(sessionID, offraidData) {
		// resolve original container
		const inraidController = Mod.container.resolve("InraidController");
		
		const preRaidProfile = inraidController.saveServer.getProfile(sessionID);
		const locationName = preRaidProfile.inraid.location.toLowerCase();
		const config = require("../config/config.json");

		const map = inraidController.databaseServer.getTables().locations[locationName].base;
		const mapHasInsuranceEnabled = map.Insurance;
		let preRaidPmcData = preRaidProfile.characters.pmc
		const isDead = inraidController.isPlayerDead(offraidData.exit);
		const preRaidGear = inraidController.inRaidHelper.getPlayerGear(preRaidPmcData.Inventory.items);
		const preRaidInsuredItems = JSON.parse(JSON.stringify(preRaidPmcData.InsuredItems));

		preRaidProfile.inraid.character = "pmc";

		preRaidPmcData = inraidController.inRaidHelper.updateProfileBaseStats(preRaidPmcData, offraidData, sessionID);

		// Check for exit status
		inraidController.markOrRemoveFoundInRaidItems(offraidData);

		offraidData.profile.Inventory.items = inraidController.itemHelper.replaceIDs(offraidData.profile, offraidData.profile.Inventory.items, preRaidPmcData.InsuredItems, offraidData.profile.Inventory.fastPanel);
		inraidController.inRaidHelper.addUpdToMoneyFromRaid(offraidData.profile.Inventory.items);

		preRaidPmcData = inraidController.inRaidHelper.setInventory(sessionID, preRaidPmcData, offraidData.profile);
		inraidController.healthHelper.saveVitality(preRaidPmcData, offraidData.health, sessionID);
		
		// Edge case - Handle usec players leaving lighthouse with Rogues angry at them
        if (locationName === "lighthouse" && offraidData.profile.Info.Side.toLowerCase() === "usec")
        {
            // Decrement counter if it exists, don't go below 0
            const remainingCounter = preRaidPmcData?.Stats.Eft.OverallCounters.Items.find(x => x.Key.includes("UsecRaidRemainKills"));
            if (remainingCounter?.Value > 0)
            {
                remainingCounter.Value --;
            }
        }

		// remove inventory if player died and send insurance items
		if (isDead) {
			inraidController.pmcChatResponseService.sendKillerResponse(sessionID, preRaidPmcData, offraidData.profile.Stats.Eft.Aggressor);
            inraidController.matchBotDetailsCacheService.clearCache();
			
			preRaidPmcData = Mod.customPostDeath(offraidData, preRaidPmcData, mapHasInsuranceEnabled, preRaidGear, sessionID);
		}
		
		const victims = offraidData.profile.Stats.Eft.Victims.filter(x => x.Role === "sptBear" || x.Role === "sptUsec");
        if (victims?.length > 0) {
            inraidController.pmcChatResponseService.sendVictimResponse(sessionID, victims, preRaidPmcData);
        }
		
		// save post raid gear after you're done with deleting non insured items
		const postRaidGear = preRaidPmcData.Inventory.items;
		
		
		if (config.EnableDefaultInsurance) {
			if (mapHasInsuranceEnabled) {
				Mod.customStoreLostGear(preRaidPmcData, postRaidGear, preRaidGear, preRaidInsuredItems, sessionID, isDead, offraidData);
				inraidController.insuranceService.sendInsuredItems(preRaidPmcData, sessionID, map.Id);
			} else {
				inraidController.insuranceService.sendLostInsuranceMessage(sessionID);
			}
		}
	}
	
	static customPostDeath(postRaidSaveRequest, pmcData, insuranceEnabled, preRaidGear, sessionID) {
		// resolve og container
		const inraidController = Mod.container.resolve("InraidController");
		const QuestStatus = require("C:/snapshot/project/obj/models/enums/QuestStatus");
		
		inraidController.updatePmcHealthPostRaid(postRaidSaveRequest, pmcData);		
		pmcData = Mod.customDeleteInv(pmcData, sessionID);

		// Remove quest items
        if (inraidController.inRaidHelper.removeQuestItemsOnDeath()) {
            // Find and remove the completed condition from profile if player died, otherwise quest is stuck in limbo and quest items cannot be picked up again
            const allQuests = inraidController.questHelper.getQuestsFromDb();
            const activeQuestIdsInProfile = pmcData.Quests.filter(x => ![QuestStatus.AvailableForStart, QuestStatus.Success, QuestStatus.Expired].includes(x.status)).map(x => x.qid);
            for (const questItem of postRaidSaveRequest.profile.Stats.Eft.CarriedQuestItems)
            {
                // Get quest/find condition for carried quest item
                const questAndFindItemConditionId = inraidController.questHelper.getFindItemConditionByQuestItem(questItem, activeQuestIdsInProfile, allQuests);
                if (questAndFindItemConditionId)
                {
                    inraidController.profileHelper.removeCompletedQuestConditionFromProfile(pmcData, questAndFindItemConditionId);
                }
            }

            // Empty out stored quest items from player inventory
            pmcData.Stats.Eft.CarriedQuestItems = [];
        }


		return pmcData;
	}
	
	static customDeleteInv(pmcData, sessionID) {
		// resolve required containers, yada yada
		const inRaidHelper = Mod.container.resolve("InRaidHelper");
		const logger = Mod.container.resolve("WinstonLogger");
		const database = Mod.container.resolve("DatabaseServer").getTables();
		const config = require("../config/config.json");
		
		const insuredItems = [];
		let deleteObj = {
			"DeleteItem": [],
			"DeleteInsurance": []
		};
		const dbParentIdsToCheck = [
			"5795f317245977243854e041",	// Container
			"5448e54d4bdc2dcc718b4568",	// Armor
			"5448e5284bdc2dcb718b4567",	// Vest
			"5448e53e4bdc2d60728b4567",	// Backpack
			"5a341c4086f77401f2541505",	// Headwear
			"5447bed64bdc2d97278b4568",	// Machine Guns
			"5447b6254bdc2dc3278b4568",	// Snipers Rifles
			"5447b5e04bdc2d62278b4567",	// Smgs
			"5447b6094bdc2dc3278b4567",	// Shotguns
			"5447b5cf4bdc2d65278b4567",	// Pistol
			"5447b6194bdc2d67278b4567",	// Marksman Rifles
			"5447b5f14bdc2d61278b4567",	// Assault Rifles
			"5447b5fc4bdc2d87278b4567",	// Assault Carbines
			"617f1ef5e8b54b0998387733"	// Revolvers
		];
		
		// dump all insured items in a simple array
		for (const insItem of pmcData.InsuredItems) {
			insuredItems.push(insItem.itemId);
		}

		for (const item of pmcData.Inventory.items) {
			
			// loop through inventory items
			if (item.parentId === pmcData.Inventory.equipment) {
				// add equipped insured items to an insurance delete array
				if (insuredItems.includes(item._id)) {
					deleteObj.DeleteInsurance.push(item._id);
				}
				
				// handle them pockets
				if (item.slotId.startsWith("Pockets")) {
					deleteObj = Mod.handleInventoryItems(pmcData, item, insuredItems, dbParentIdsToCheck, database, deleteObj);
				}
				
				// push uninsured item to delete array
				if (!inRaidHelper.isItemKeptAfterDeath(pmcData, item) && !insuredItems.includes(item._id) || item.parentId === pmcData.Inventory.questRaidItems) {
					deleteObj.DeleteItem.push(item._id);
				}
				
				// Remove items inside gear items
				if (item.slotId != "hideout" && item.slotId != "FirstPrimaryWeapon" && item.slotId != "SecondPrimaryWeapon" && item.slotId != "Holster" && !inRaidHelper.isItemKeptAfterDeath(pmcData, item)) {
					deleteObj = Mod.handleInventoryItems(pmcData, item, insuredItems, dbParentIdsToCheck, database, deleteObj);
				}
				
				// handle equipped guns, since we don't want want them becoming unoperable in player hands
				if (item.slotId === "FirstPrimaryWeapon" || item.slotId === "SecondPrimaryWeapon" || item.slotId === "Holster") {
					deleteObj = Mod.handleEquippedGuns(pmcData, item, insuredItems, dbParentIdsToCheck, database, deleteObj);
				}
			}
		}
		
		// remove insurance from equipped items
		if (config.LoseInsuranceOnItemAfterDeath) {
			pmcData.InsuredItems = Mod.removeInsurance(pmcData.InsuredItems, deleteObj.DeleteInsurance)
		}

		// delete items
		for (const item of deleteObj.DeleteItem) {
			inRaidHelper.inventoryHelper.removeItem(pmcData, item, sessionID);
		}

		pmcData.Inventory.fastPanel = {};

		return pmcData;
	}
	
	static customStoreLostGear(pmcData, postRaidGear, preRaidGear, preRaidInsuredItems, sessionID, playerDied, offraidData) {
		// resolve required container, yada yada
		const insuranceService = Mod.container.resolve("InsuranceService");
		
		const preRaidGearHash = insuranceService.createItemHashTable(preRaidGear);
		const offRaidGearHash = insuranceService.createItemHashTable(postRaidGear);
		
		const equipmentToSendToPlayer = [];

		for (const insuredItem of preRaidInsuredItems) {
			
			// Skip insured items not on player when they started raid
            const preRaidItem = preRaidGearHash[insuredItem.itemId];
            if (!preRaidItem)
            {
                continue;
            }
			
			// Skip items we should never return
            if (insuranceService.insuranceConfig.blacklistedEquipment.includes(preRaidItem.slotId))
            {
                continue;
            }
			
			if (preRaidGearHash[insuredItem.itemId]) {
				// This item exists in preRaidGear, meaning we brought it into the raid...
				// Check if we brought it out of the raid
				if (!offRaidGearHash[insuredItem.itemId] /*|| playerDied*/) {
					// We didn't bring this item out! We must've lost it.
					equipmentToSendToPlayer.push({
						pmcData: pmcData,
						itemToReturnToPlayer: insuranceService.getInsuredItemDetails(pmcData, preRaidItem, offraidData.insurance?.find(x => x.id === insuredItem.itemId)),
						traderId: insuredItem.tid,
						sessionID: sessionID
					});
				}
			}
		}

		for (const gear of equipmentToSendToPlayer) {
			insuranceService.addGearToSend(gear);
		}
	}
	
	static handleInventoryItems(pmcData, item, insuredItems, dbParentIdsToCheck, database, returnObj) {
		for (const itemInInventory of pmcData.Inventory.items.filter(x => x.parentId == item._id)) {
			// Don't delete items in special slots
			// also skip insured items
			if (!itemInInventory.slotId.includes("SpecialSlot")) {
				
				// add equipped insured items to an insurance delete array
				if (insuredItems.includes(itemInInventory._id)) {
					returnObj.DeleteInsurance.push(itemInInventory._id);
				}
				
				if (!insuredItems.includes(itemInInventory._id) && !returnObj.DeleteItem.includes(itemInInventory._id)) {
					returnObj.DeleteItem.push(itemInInventory._id);
				} else if (dbParentIdsToCheck.includes(database.templates.items[itemInInventory._tpl]._parent)) {
					returnObj = Mod.handleInventoryItems(pmcData, itemInInventory, insuredItems, dbParentIdsToCheck, database, returnObj)
				}
			}
		}
		
		return returnObj;
	}
	
	
	// TO-DO
	// this goes through bunch of useless loops, find where and remove
	static handleEquippedGuns(pmcData, item, insuredItems, dbParentIdsToCheck, database, returnObj) {
		const logger = Mod.container.resolve("WinstonLogger");
		
		for (const itemInInventory of pmcData.Inventory.items.filter(x => x.parentId == item._id)) {
			
			
			
			// skip if its ammo, we want to keep it
			if (database.templates.items[itemInInventory._tpl]._parent === "5485a8684bdc2da71d8b4567") {
				continue;
			}
			
			// add to insured array if insured
			if (insuredItems.includes(itemInInventory._id)) {
				returnObj.DeleteInsurance.push(itemInInventory._id);
			}
			
			if (database.templates.items[item._tpl]._props.Slots.length != 0) {
				for (const slotsIndex in database.templates.items[item._tpl]._props.Slots) {
					if (database.templates.items[item._tpl]._props.Slots[slotsIndex]._props.filters[0].Filter.includes(itemInInventory._tpl)) {
						
						// check if the item is required, like pistol grips, gasblocks, etc
						if (!insuredItems.includes(itemInInventory._id) && !returnObj.DeleteItem.includes(itemInInventory._id) && database.templates.items[item._tpl]._props.Slots[slotsIndex]._required === false) {
							returnObj.DeleteItem.push(itemInInventory._id);
							break;
						}
					}
				}
			} else if (!insuredItems.includes(itemInInventory._id) && !returnObj.DeleteItem.includes(itemInInventory._id)) {
				returnObj.DeleteItem.push(itemInInventory._id);
			}
			
			// if item can have slots and is insured, call this function again
			if (database.templates.items[itemInInventory._tpl]._props.Slots.length != 0 && insuredItems.includes(itemInInventory._id)) {
				returnObj = Mod.handleEquippedGuns(pmcData, itemInInventory, insuredItems, dbParentIdsToCheck, database, returnObj)
			}
			
		}
		
		return returnObj;
	}
	
	static removeInsurance(insuredItemsList, itemsToRemove) {
		const returnList = insuredItemsList.filter(entry => !itemsToRemove.includes(entry.itemId));
		
		return returnList;
	}
	
}

	
module.exports = { mod: new Mod() }