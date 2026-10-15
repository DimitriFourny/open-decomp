export const ENCODINGS = [
    {
        "instructionId": "NGC_SBC",
        "encodingId": "NGC_SBC_32_addsub_carry",
        "mnemonic": "SBC",
        "className": "Not setting the condition flags",
        "fileName": "ngc_sbc.xml",
        "mask": 4292935648,
        "value": 1509950432,
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
        "canonicalEncodingId": "SBC_32_addsub_carry",
        "canonicalFileName": "sbc.xml",
        "operandFamilyId": "gp-rd-rn-rm-sf",
        "operandSchemaId": "gp-rd-rn-rm-sf"
    },
    {
        "instructionId": "NGC_SBC",
        "encodingId": "NGC_SBC_64_addsub_carry",
        "mnemonic": "SBC",
        "className": "Not setting the condition flags",
        "fileName": "ngc_sbc.xml",
        "mask": 4292935648,
        "value": 3657434080,
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
        "canonicalEncodingId": "SBC_64_addsub_carry",
        "canonicalFileName": "sbc.xml",
        "operandFamilyId": "gp-rd-rn-rm-sf",
        "operandSchemaId": "gp-rd-rn-rm-sf"
    }
];
