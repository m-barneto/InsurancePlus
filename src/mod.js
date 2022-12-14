﻿"use strict";

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
	
	static customSavePmc(sessionID, offraidData)
	{
		// resolve original container
		const inraidController = Mod.container.resolve("InraidController");
		
		const currentProfile = inraidController.saveServer.getProfile(sessionID);
		const locationName = currentProfile.inraid.location.toLowerCase();

		const map = inraidController.databaseServer.getTables().locations[locationName].base;
		const insuranceEnabled = map.Insurance;
		let pmcData = currentProfile.characters.pmc;
		const isDead = inraidController.isPlayerDead(offraidData.exit);
		const preRaidGear = inraidController.inRaidHelper.getPlayerGear(pmcData.Inventory.items);

		currentProfile.inraid.character = "pmc";

		pmcData = inraidController.inRaidHelper.updateProfileBaseStats(pmcData, offraidData, sessionID);

		// Check for exit status
		inraidController.markOrRemoveFoundInRaidItems(offraidData, pmcData, false);

		offraidData.profile.Inventory.items = inraidController.itemHelper.replaceIDs(offraidData.profile, offraidData.profile.Inventory.items, pmcData.InsuredItems, offraidData.profile.Inventory.fastPanel);
		inraidController.inRaidHelper.addUpdToMoneyFromRaid(offraidData.profile.Inventory.items);

		pmcData = inraidController.inRaidHelper.setInventory(sessionID, pmcData, offraidData.profile);
		inraidController.healthHelper.saveVitality(pmcData, offraidData.health, sessionID);

		// remove inventory if player died and send insurance items
		if (isDead)
		{
			pmcData = Mod.customPostDeath(offraidData, pmcData, insuranceEnabled, preRaidGear, sessionID);
		}
		
		if (insuranceEnabled)
		{
			inraidController.insuranceService.storeLostGear(pmcData, offraidData, preRaidGear, sessionID);
		}

		if (insuranceEnabled)
		{
			inraidController.insuranceService.sendInsuredItems(pmcData, sessionID, map.Id);
		}
	}
	
	static customPostDeath(postRaidSaveRequest, pmcData, insuranceEnabled, preRaidGear, sessionID) 
	{
		// resolve og container
		const inraidController = Mod.container.resolve("InraidController");
		
		// love me some logging
		const logger = Mod.container.resolve("WinstonLogger");
		
		inraidController.updatePmcHealthPostRaid(postRaidSaveRequest, pmcData);

		// since you don't lose anything, we don't need this anymore
		/*
		if (insuranceEnabled)
		{
			this.insuranceService.storeInsuredItemsForReturn(pmcData, postRaidSaveRequest, preRaidGear, sessionID);
		}
		*/
		
		pmcData = Mod.customDeleteInv(pmcData, sessionID, logger);
		
		//logger.info("so dead, very wow")

		for (const questItem of postRaidSaveRequest.profile.Stats.CarriedQuestItems)
		{
			const findItemConditionId = inraidController.questHelper.getFindItemIdForQuestHandIn(questItem);
			inraidController.profileHelper.resetProfileQuestCondition(sessionID, findItemConditionId);
		}

		pmcData.Stats.CarriedQuestItems = [];

		return pmcData;
	}
	
	static customDeleteInv(pmcData, sessionID, logger) 
	{
		// resolve required container, yada yada
		const inRaidHelper = Mod.container.resolve("InRaidHelper");
		
		//logger.info("yeah it works chief")
		
		const toDelete = [];
		const insuredItems = [];
		
		// dump all insured items in a simple array
		for (const insItem of pmcData.InsuredItems) {
			insuredItems.push(insItem.itemId);
		};

		for (const item of pmcData.Inventory.items) {
			
			// Remove normal items only or quest raid items
			if (item.parentId === pmcData.Inventory.equipment) {
				if (item.parentId === pmcData.Inventory.equipment && !inRaidHelper.isItemKeptAfterDeath(item.slotId) && !insuredItems.includes(item._id) || item.parentId === pmcData.Inventory.questRaidItems) {
					toDelete.push(item._id);
				};
			};
			
			// Remove items in pockets, backpacks and rigs
			if (item.slotId === "Pockets" || item.slotId === "TacticalVest" || item.slotId === "Backpack") {
				for (const itemInInventory of pmcData.Inventory.items.filter(x => x.parentId == item._id)) {
					// Don't delete items in special slots
					// Can be special slot 1, 2 or 3
					// also skip insured items
					if (itemInInventory.slotId.includes("SpecialSlot") || insuredItems.includes(itemInInventory._id)) {
						continue;
					};
					
					toDelete.push(itemInInventory._id);
				}
			};
			
		};

		// delete items
		for (const item of toDelete) {
			inRaidHelper.inventoryHelper.removeItem(pmcData, item, sessionID);
		};

		pmcData.Inventory.fastPanel = {};

		return pmcData;
	}
}

	
module.exports = { mod: new Mod() }