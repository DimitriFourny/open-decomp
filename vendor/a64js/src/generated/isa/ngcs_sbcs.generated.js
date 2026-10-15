export const ENCODINGS = [
    {
        "instructionId": "NGCS_SBCS",
        "encodingId": "NGCS_SBCS_32_addsub_carry",
        "mnemonic": "SBCS",
        "className": "Setting the condition flags",
        "fileName": "ngcs_sbcs.xml",
        "mask": 4292935648,
        "value": 2046821344,
        "bitCount": 22,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "canonicalEncodingId": "SBCS_32_addsub_carry",
        "canonicalFileName": "sbcs.xml",
        "operandFamilyId": "gp-rd-rn-rm-sf",
        "operandSchemaId": "gp-rd-rn-rm-sf"
    },
    {
        "instructionId": "NGCS_SBCS",
        "encodingId": "NGCS_SBCS_64_addsub_carry",
        "mnemonic": "SBCS",
        "className": "Setting the condition flags",
        "fileName": "ngcs_sbcs.xml",
        "mask": 4292935648,
        "value": 4194304992,
        "bitCount": 22,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "canonicalEncodingId": "SBCS_64_addsub_carry",
        "canonicalFileName": "sbcs.xml",
        "operandFamilyId": "gp-rd-rn-rm-sf",
        "operandSchemaId": "gp-rd-rn-rm-sf"
    }
];
